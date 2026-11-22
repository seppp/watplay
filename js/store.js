// Storage layer. Two backends with the same interface:
//   - Firestore (shared, used when js/config.js has a projectId)
//   - localStorage (single browser, used otherwise)
//
// Data layout
//   groups/{slug}   public directory entry: { name, protected, createdAt }
//   spaces/{key}    the group's actual data (lists, sections, votes)
//
// spaces/{key}/claims/{uid}  { name, at }: a member name linked to a Google
//                account. Only that account can write or remove its claim, and
//                for each name the earliest claim wins.
//
// The space key is sha256("watplay:v1:" + slug + ":" + password). Without the
// password you cannot compute the key, and the security rules forbid listing
// spaces, so a protected group's data cannot be found or read.
import { firebaseConfig } from "./config.js";

const FIREBASE_VERSION = "10.14.1";

export const isShared = !!(firebaseConfig && firebaseConfig.projectId);

export async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function spaceKey(slug, password = "") {
  return sha256(`watplay:v1:${slug}:${password}`);
}

export function slugify(name) {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

async function firestoreBackend() {
  const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
  const { initializeApp } = await import(`${base}/firebase-app.js`);
  const fs = await import(`${base}/firebase-firestore.js`);
  const app = initializeApp(firebaseConfig);
  const db = fs.getFirestore(app);

  // Google sign-in is optional: the auth module loads on first use.
  let authPromise;
  const loadAuth = () =>
    (authPromise ??= import(`${base}/firebase-auth.js`).then((m) => ({ m, auth: m.getAuth(app) })));
  const listeners = new Set();
  let user = null;
  let authStarted = false;
  const startAuth = () => {
    if (authStarted) return;
    authStarted = true;
    loadAuth()
      .then(({ m, auth }) =>
        m.onAuthStateChanged(auth, (u) => {
          user = u ? { uid: u.uid, email: u.email || "", name: u.displayName || "" } : null;
          listeners.forEach((cb) => cb(user));
        })
      )
      .catch(() => {});
  };

  return {
    auth: {
      available: true,
      user: () => user,
      onChange(cb) {
        listeners.add(cb);
        startAuth();
        return () => listeners.delete(cb);
      },
      async signIn() {
        const { m, auth } = await loadAuth();
        startAuth();
        try {
          await m.signInWithPopup(auth, new m.GoogleAuthProvider());
        } catch (e) {
          if (e.code === "auth/popup-closed-by-user" || e.code === "auth/cancelled-popup-request") return null;
          if (e.code === "auth/operation-not-allowed" || e.code === "auth/configuration-not-found")
            throw new Error("Google sign-in isn't turned on in Firebase yet (see README).");
          if (e.code === "auth/unauthorized-domain")
            throw new Error("This website isn't in Firebase's authorized domains yet (see README).");
          throw e;
        }
        const u = auth.currentUser;
        user = u ? { uid: u.uid, email: u.email || "", name: u.displayName || "" } : null;
        return user;
      },
      async signOut() {
        const { m, auth } = await loadAuth();
        await m.signOut(auth);
      },
    },
    subscribeClaims(key, onData) {
      return fs.onSnapshot(
        fs.collection(db, "spaces", key, "claims"),
        (snap) => onData(snap.docs.map((d) => ({ uid: d.id, name: d.data().name, at: d.data().at?.toMillis?.() ?? Date.now() }))),
        () => onData([])
      );
    },
    async setClaim(key, uid, name) {
      await fs.setDoc(fs.doc(db, "spaces", key, "claims", uid), { name, at: fs.serverTimestamp() });
    },
    async removeClaim(key, uid) {
      await fs.deleteDoc(fs.doc(db, "spaces", key, "claims", uid));
    },
    async getGroup(slug) {
      const snap = await fs.getDoc(fs.doc(db, "groups", slug));
      return snap.exists() ? snap.data() : null;
    },
    async createGroup(slug, meta, key, space) {
      await fs.runTransaction(db, async (tx) => {
        const ref = fs.doc(db, "groups", slug);
        if ((await tx.get(ref)).exists()) throw new Error("That group name is already taken.");
        tx.set(ref, meta);
        tx.set(fs.doc(db, "spaces", key), space);
      });
    },
    subscribe(key, onData, onError) {
      return fs.onSnapshot(
        fs.doc(db, "spaces", key),
        (snap) => onData(snap.exists() ? snap.data() : null),
        onError
      );
    },
    async mutate(key, fn) {
      await fs.runTransaction(db, async (tx) => {
        const ref = fs.doc(db, "spaces", key);
        const snap = await tx.get(ref);
        if (!snap.exists()) throw new Error("Group data not found.");
        const data = snap.data();
        fn(data);
        tx.set(ref, data);
      });
    },
  };
}

function localBackend() {
  const PREFIX = "watplay:local:";
  const read = (k) => {
    try {
      const v = localStorage.getItem(PREFIX + k);
      return v ? JSON.parse(v) : null;
    } catch {
      return null;
    }
  };
  const write = (k, v) => {
    localStorage.setItem(PREFIX + k, JSON.stringify(v));
    window.dispatchEvent(new CustomEvent("watplay-local", { detail: k }));
  };

  return {
    auth: { available: false, user: () => null, onChange: () => () => {} },
    subscribeClaims(key, onData) {
      queueMicrotask(() => onData([]));
      return () => {};
    },
    async getGroup(slug) {
      return read(`groups/${slug}`);
    },
    async createGroup(slug, meta, key, space) {
      if (read(`groups/${slug}`)) throw new Error("That group name is already taken.");
      write(`groups/${slug}`, meta);
      write(`spaces/${key}`, space);
    },
    subscribe(key, onData) {
      const k = `spaces/${key}`;
      const emit = () => onData(read(k));
      const onLocal = (e) => e.detail === k && emit();
      const onStorage = (e) => e.key === PREFIX + k && emit();
      window.addEventListener("watplay-local", onLocal);
      window.addEventListener("storage", onStorage);
      queueMicrotask(emit);
      return () => {
        window.removeEventListener("watplay-local", onLocal);
        window.removeEventListener("storage", onStorage);
      };
    },
    async mutate(key, fn) {
      const k = `spaces/${key}`;
      const data = read(k);
      if (!data) throw new Error("Group data not found.");
      fn(data);
      write(k, data);
    },
  };
}

let backendPromise;
export function backend() {
  backendPromise ??= isShared ? firestoreBackend() : Promise.resolve(localBackend());
  return backendPromise;
}
