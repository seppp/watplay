import { backend, isShared, spaceKey, slugify } from "./store.js";
import { parseLink, steamCoverFallback } from "./links.js";

// ---------- helpers ----------
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
const app = $("#app");
const dialog = $("#dialog");

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3200);
}

// Per-device memory: which groups you opened, the key to reach them, and who you are in each.
const SESS = "watplay:sessions";
function sessions() {
  try {
    return JSON.parse(localStorage.getItem(SESS)) || {};
  } catch {
    return {};
  }
}
function saveSession(slug, patch) {
  const all = sessions();
  all[slug] = { ...all[slug], ...patch, seen: Date.now() };
  try {
    localStorage.setItem(SESS, JSON.stringify(all));
  } catch {}
}
function forgetSession(slug) {
  const all = sessions();
  delete all[slug];
  try {
    localStorage.setItem(SESS, JSON.stringify(all));
  } catch {}
}

function openDialog(html, onSubmit) {
  dialog.innerHTML = html;
  dialog.showModal();
  const form = $("form", dialog);
  if (form && onSubmit) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (e.submitter?.value === "cancel") return dialog.close();
      const err = $(".error", form);
      try {
        const keepOpen = await onSubmit(new FormData(form), form, e.submitter);
        if (!keepOpen) dialog.close();
      } catch (ex) {
        if (err) err.textContent = ex.message;
        else toast(ex.message);
      }
    });
  }
  $("[autofocus]", dialog)?.focus();
}

function confirmBox(message, okLabel = "Delete") {
  return new Promise((resolve) => {
    openDialog(
      `<form><p>${esc(message)}</p>
        <div class="actions-end"><button value="cancel">Cancel</button><button class="primary" value="ok">${esc(okLabel)}</button></div></form>`,
      () => resolve(true)
    );
    dialog.addEventListener("close", () => resolve(false), { once: true });
  });
}

// ---------- state ----------
let be; // storage backend
let cur = null; // the open group: { slug, meta, key, data, unsub, view, me }

const DEFAULT_SPACE = (name, me, opts) => ({
  v: 1,
  name,
  noun: opts.noun || "game",
  nouns: opts.nouns || "games",
  mode: opts.mode === "manual" ? "manual" : "vote",
  members: me ? [me] : [],
  cats: (opts.cats || []).map((n) => ({ id: uid(), name: n })),
  items: [],
  createdAt: Date.now(),
});

function change(fn) {
  if (!cur) return Promise.resolve();
  return be.mutate(cur.key, fn).catch((e) => toast(e.message || "Could not save."));
}

// ---------- routing ----------
async function route() {
  if (cur) {
    cur.unsub?.();
    cur = null;
  }
  const m = location.hash.match(/^#\/g\/([^/]+)/);
  if (m) await openGroup(decodeURIComponent(m[1]));
  else renderHome();
}

// ---------- home ----------
function renderHome() {
  document.title = "watplay · what should we play next?";
  const recent = Object.entries(sessions()).sort((a, b) => (b[1].seen || 0) - (a[1].seen || 0));
  app.innerHTML = `
    <section class="panel" style="background:transparent;border:0;box-shadow:none;padding:0.5rem 0">
      <h1>What should we play next?</h1>
      <p class="muted">Make a group, throw in games (paste a Steam link or just type a name), sort them into sections, then vote or drag them into order.</p>
    </section>
    ${
      isShared
        ? ""
        : `<div class="notice"><strong>Local mode.</strong> Groups are saved in this browser only. To share groups with friends, add a free Firebase config as described in the README.</div>`
    }
    ${
      recent.length
        ? `<section class="panel"><h2>Your groups</h2><ul class="recent">${recent
            .map(
              ([slug, s]) =>
                `<li><a href="#/g/${encodeURIComponent(slug)}">${esc(s.name || slug)}</a><span class="muted small">${s.me ? "as " + esc(s.me) : ""}</span></li>`
            )
            .join("")}</ul></section>`
        : ""
    }
    <div class="grid2">
      <form class="panel" id="open-form">
        <h2>Open a group</h2>
        <label for="open-name">Group name</label>
        <input id="open-name" name="name" required placeholder="e.g. Friday Night Crew" autocomplete="off" />
        <p class="error"></p>
        <div class="actions-end"><button class="primary">Open</button></div>
      </form>
      <form class="panel" id="create-form">
        <h2>Create a group</h2>
        <label for="c-name">Group name</label>
        <input id="c-name" name="name" required maxlength="60" placeholder="e.g. Friday Night Crew" autocomplete="off" />
        <label for="c-me">Your name</label>
        <input id="c-me" name="me" required maxlength="30" placeholder="e.g. hansl" autocomplete="nickname" />
        <label for="c-pass">Password (optional)</label>
        <input id="c-pass" name="password" type="password" autocomplete="new-password" placeholder="Leave empty for an open group" />
        <label for="c-cats">Sections (optional, comma separated)</label>
        <input id="c-cats" name="cats" placeholder="e.g. Co-op, Strategy, Quick rounds" />
        <fieldset>
          <legend class="small muted" style="font-weight:400;margin-top:.5rem">How do you order the list?</legend>
          <label class="radio"><input type="radio" name="mode" value="vote" checked /> Voting (everyone rates 1–5)</label>
          <label class="radio"><input type="radio" name="mode" value="manual" /> Drag and drop</label>
        </fieldset>
        <p class="error"></p>
        <div class="actions-end"><button class="primary">Create group</button></div>
      </form>
    </div>`;

  $("#open-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const slug = slugify(new FormData(e.target).get("name"));
    if (!slug) return ($(".error", e.target).textContent = "Type a group name.");
    location.hash = `#/g/${encodeURIComponent(slug)}`;
  });

  $("#create-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const f = new FormData(form);
    const err = $(".error", form);
    const name = f.get("name").trim();
    const me = f.get("me").trim();
    const password = f.get("password");
    const slug = slugify(name);
    if (!slug) return (err.textContent = "Use at least one letter or number in the group name.");
    const btn = $("button.primary", form);
    btn.disabled = true;
    err.textContent = "";
    try {
      const key = await spaceKey(slug, password);
      const cats = String(f.get("cats") || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 30);
      await be.createGroup(slug, { name, protected: !!password, createdAt: Date.now() }, key, DEFAULT_SPACE(name, me, { cats, mode: f.get("mode") }));
      saveSession(slug, { key, me, name });
      location.hash = `#/g/${encodeURIComponent(slug)}`;
    } catch (ex) {
      err.textContent = ex.message || "Could not create the group.";
    } finally {
      btn.disabled = false;
    }
  });
}

// ---------- opening a group ----------
async function openGroup(slug) {
  app.innerHTML = `<p class="muted">Opening group…</p>`;
  let meta;
  try {
    meta = await be.getGroup(slug);
  } catch (e) {
    app.innerHTML = `<div class="panel"><h2>Could not reach the server</h2><p class="muted">${esc(e.message)}</p><a href="#/">Back</a></div>`;
    return;
  }
  if (!meta) {
    app.innerHTML = `<div class="panel"><h2>No group called “${esc(slug)}”</h2>
      <p class="muted">Check the spelling, or create it from the start page.</p><a href="#/">Back to start</a></div>`;
    return;
  }
  const saved = sessions()[slug];
  if (saved?.key) return attach(slug, meta, saved.key, { fromSaved: true });
  if (!meta.protected) return attach(slug, meta, await spaceKey(slug, ""), {});
  askPassword(slug, meta);
}

function askPassword(slug, meta, message = "") {
  document.title = `${meta.name} · watplay`;
  app.innerHTML = `
    <form class="panel" id="pw-form" style="max-width:420px;margin:2rem auto">
      <h2>🔒 ${esc(meta.name)}</h2>
      <p class="muted">This group is password protected.</p>
      <label for="pw">Password</label>
      <input id="pw" name="password" type="password" required autocomplete="current-password" autofocus />
      <p class="error">${esc(message)}</p>
      <div class="actions-end"><a href="#/" style="align-self:center">Back</a><button class="primary">Open</button></div>
    </form>`;
  $("#pw").focus();
  $("#pw-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const key = await spaceKey(slug, new FormData(e.target).get("password"));
    attach(slug, meta, key, { fromPassword: true });
  });
}

function attach(slug, meta, key, { fromSaved, fromPassword }) {
  const prev = sessions()[slug] || {};
  cur = { slug, meta, key, data: null, view: "next", me: prev.me || "", shellReady: false };
  const mine = cur;
  cur.unsub = be.subscribe(
    key,
    (data) => {
      if (cur !== mine) return;
      if (!data) {
        cur.unsub?.();
        cur = null;
        if (fromSaved) forgetSession(slug);
        if (meta.protected) askPassword(slug, meta, fromPassword ? "Wrong password." : fromSaved ? "Your saved password no longer works." : "");
        else app.innerHTML = `<div class="panel"><h2>This group has no data</h2><a href="#/">Back</a></div>`;
        return;
      }
      cur.data = normalize(data);
      saveSession(slug, { key, name: cur.data.name });
      renderGroup();
    },
    (err) => toast(err.message || "Lost connection.")
  );
}

function normalize(d) {
  d.members ||= [];
  d.cats ||= [];
  d.items ||= [];
  d.noun ||= "game";
  d.nouns ||= "games";
  d.mode = d.mode === "manual" ? "manual" : "vote";
  for (const it of d.items) it.votes ||= {};
  return d;
}

// ---------- group view ----------
function renderGroup() {
  const d = cur.data;
  document.title = `${d.name} · watplay`;
  if (!cur.shellReady) {
    app.innerHTML = `
      <div class="group-head" id="g-head"></div>
      <nav class="tabs" id="g-tabs" role="tablist"></nav>
      <form class="panel add-form" id="add-form" autocomplete="off">
        <div class="row">
          <input name="link" id="add-link" placeholder="Steam link (optional)" inputmode="url" />
          <input name="title" id="add-title" required maxlength="120" />
          <select name="cat" id="add-cat" aria-label="Section"></select>
          <button class="primary" id="add-btn">Add</button>
        </div>
        <div class="preview" id="add-preview" hidden></div>
      </form>
      <ul class="list" id="g-list"></ul>
      <div id="g-foot"></div>`;
    cur.shellReady = true;
    wireShell();
  }
  if (cur.view !== "next" && cur.view !== "played" && !d.cats.some((c) => c.id === cur.view)) cur.view = "next";
  renderHead();
  renderTabs();
  renderAddForm();
  renderList();
  if (!cur.me || !d.members.includes(cur.me)) askWhoAmI();
}

function renderHead() {
  const d = cur.data;
  $("#g-head").innerHTML = `
    <div>
      <h1>${cur.meta.protected ? "🔒 " : ""}${esc(d.name)}</h1>
      <div class="sub">${d.mode === "vote" ? "Ranked by votes" : "Ordered by drag and drop"} · ${d.members.length} member${d.members.length === 1 ? "" : "s"}${
        cur.me ? ` · you are <span class="me">${esc(cur.me)}</span> <button class="icon small" data-act="whoami" title="Switch person">switch</button>` : ""
      }</div>
    </div>
    <div class="row">
      <button data-act="share" title="Copy link to this group">🔗 Share</button>
      <button data-act="settings">⚙️ Settings</button>
    </div>`;
}

function counts() {
  const d = cur.data;
  const c = { next: 0, played: 0 };
  for (const it of d.items) {
    if (it.played) c.played++;
    else {
      c.next++;
      if (it.cat) c[it.cat] = (c[it.cat] || 0) + 1;
    }
  }
  return c;
}

function renderTabs() {
  const d = cur.data;
  const c = counts();
  const tab = (id, label, n) =>
    `<button class="tab" role="tab" data-view="${esc(id)}" aria-selected="${cur.view === id}">${esc(label)}<span class="count">${n || 0}</span></button>`;
  $("#g-tabs").innerHTML =
    tab("next", "⭐ Play next", c.next) +
    d.cats.map((cat) => tab(cat.id, cat.name, c[cat.id])).join("") +
    tab("played", "✓ Played", c.played) +
    `<button class="tab" data-act="add-cat" title="Add a section">＋ Section</button>`;
}

function renderAddForm() {
  const d = cur.data;
  $("#add-title").placeholder = `${cap(d.noun)} name`;
  $("#add-btn").textContent = `Add ${d.noun}`;
  const sel = $("#add-cat");
  const want = d.cats.some((c) => c.id === cur.view) ? cur.view : sel.value;
  sel.innerHTML = `<option value="">No section</option>` + d.cats.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("");
  sel.value = d.cats.some((c) => c.id === want) ? want : "";
  sel.hidden = d.cats.length === 0;
  $("#add-form").hidden = cur.view === "played";
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function scoreOf(item, members) {
  const votes = members.map((m) => item.votes[m]).filter((n) => typeof n === "number");
  if (!votes.length) return { avg: null, n: 0 };
  return { avg: votes.reduce((a, b) => a + b, 0) / votes.length, n: votes.length };
}

function visibleItems() {
  const d = cur.data;
  let items = d.items.map((it, index) => ({ it, index }));
  if (cur.view === "played") items = items.filter((x) => x.it.played);
  else {
    items = items.filter((x) => !x.it.played);
    if (cur.view !== "next") items = items.filter((x) => x.it.cat === cur.view);
  }
  if (d.mode === "vote" && cur.view !== "played") {
    for (const x of items) x.score = scoreOf(x.it, d.members);
    items.sort((a, b) => {
      if ((a.score.avg === null) !== (b.score.avg === null)) return a.score.avg === null ? 1 : -1;
      return (b.score.avg ?? 0) - (a.score.avg ?? 0) || b.score.n - a.score.n || a.index - b.index;
    });
  }
  return items;
}

let sortable;
function renderList() {
  const d = cur.data;
  const list = $("#g-list");
  const items = visibleItems();
  const manual = d.mode === "manual" && cur.view !== "played";
  const catName = Object.fromEntries(d.cats.map((c) => [c.id, c.name]));

  if (!items.length) {
    list.innerHTML = `<li class="empty">${
      cur.view === "played"
        ? `Nothing marked as played yet.`
        : `No ${esc(d.nouns)} here yet. Paste a Steam link or type a name above.`
    }</li>`;
  } else {
    list.innerHTML = items
      .map(({ it, score }, i) => {
        const top = i === 0 && cur.view !== "played" && (manual || score?.avg !== null);
        const missing = d.members.filter((m) => typeof it.votes[m] !== "number");
        const voteTitle = d.members
          .filter((m) => typeof it.votes[m] === "number")
          .map((m) => `${m}: ${it.votes[m]}`)
          .join(", ");
        const myVote = it.votes[cur.me];
        const title = it.url
          ? `<a href="${esc(it.url)}" target="_blank" rel="noopener noreferrer">${esc(it.title)}</a>`
          : esc(it.title);
        return `
        <li class="item${top ? " top" : ""}${it.played ? " played" : ""}" data-id="${esc(it.id)}">
          ${manual ? `<span class="handle" title="Drag to reorder" aria-hidden="true">⋮⋮</span>` : `<span class="rank">${cur.view === "played" ? "✓" : i + 1}</span>`}
          ${
            it.image
              ? `<img class="cover" src="${esc(it.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-app="${esc(it.appId || "")}" data-letter="${esc((it.title || "?").charAt(0).toUpperCase())}" />`
              : `<div class="cover" aria-hidden="true">${esc((it.title || "?").charAt(0).toUpperCase())}</div>`
          }
          <div class="body">
            <div class="title">${title}</div>
            <div class="meta">${it.cat && catName[it.cat] && cur.view !== it.cat ? `<span class="chip">${esc(catName[it.cat])}</span> · ` : ""}added by ${esc(it.by || "someone")}</div>
            ${
              d.mode === "vote" && !it.played
                ? `<div class="vote" role="group" aria-label="Your rating">
                    ${[1, 2, 3, 4, 5]
                      .map((n) => `<button data-act="vote" data-n="${n}" class="${myVote === n ? "on" : ""}" aria-pressed="${myVote === n}" ${cur.me ? "" : "disabled"}>${n}</button>`)
                      .join("")}
                    <span class="score" title="${esc(voteTitle)}">${
                      score.avg === null
                        ? "no votes yet"
                        : `<strong>${score.avg.toFixed(1)}</strong> avg · ${score.n} vote${score.n === 1 ? "" : "s"}`
                    }${missing.length && score.n ? ` · waiting on ${esc(missing.join(", "))}` : ""}</span>
                  </div>`
                : ""
            }
          </div>
          <div class="item-actions">
            ${manual ? `<button class="icon" data-act="up" title="Move up" aria-label="Move up">↑</button><button class="icon" data-act="down" title="Move down" aria-label="Move down">↓</button>` : ""}
            <button class="icon" data-act="played" title="${it.played ? "Back to the list" : "Mark as played"}" aria-label="${it.played ? "Back to the list" : "Mark as played"}">${it.played ? "↩" : "✓"}</button>
            <button class="icon" data-act="edit" title="Edit" aria-label="Edit">✎</button>
            <button class="icon" data-act="delete" title="Delete" aria-label="Delete">🗑</button>
          </div>
        </li>`;
      })
      .join("");
  }

  sortable?.destroy();
  sortable = null;
  if (manual && items.length > 1 && window.Sortable) {
    sortable = window.Sortable.create(list, {
      handle: ".handle",
      animation: 150,
      onEnd: () => reorder($$(".item", list).map((li) => li.dataset.id)),
    });
  }
}

// Reorder the items shown in the current view, keeping everything else in place.
function reorder(visibleIds) {
  return change((d) => {
    const byId = Object.fromEntries(d.items.map((it) => [it.id, it]));
    const ids = visibleIds.filter((id) => byId[id]);
    const set = new Set(ids);
    const slots = [];
    d.items.forEach((it, i) => set.has(it.id) && slots.push(i));
    if (slots.length !== ids.length) return;
    slots.forEach((slot, k) => (d.items[slot] = byId[ids[k]]));
  });
}

function wireShell() {
  const linkIn = $("#add-link");
  const titleIn = $("#add-title");
  const preview = $("#add-preview");
  let autoTitle = "";
  let parsed = null;

  linkIn.addEventListener("input", () => {
    parsed = parseLink(linkIn.value);
    if (parsed?.name && (!titleIn.value || titleIn.value === autoTitle)) {
      titleIn.value = autoTitle = parsed.name;
    }
    if (parsed?.kind === "steam") {
      preview.hidden = false;
      preview.innerHTML = `<img src="${esc(parsed.image)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()" /><span>Steam app ${esc(parsed.appId)}${
        parsed.name ? "" : ". Type the name, the link didn't include it."
      }</span>`;
      if (!parsed.name && !titleIn.value) titleIn.focus();
    } else preview.hidden = true;
  });

  $("#add-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = titleIn.value.trim();
    if (!title) return titleIn.focus();
    const p = parseLink(linkIn.value);
    if (linkIn.value.trim() && !p) return toast("That link doesn't look right.");
    const item = {
      id: uid(),
      title,
      url: p?.url || "",
      image: p?.image || "",
      appId: p?.appId || "",
      cat: $("#add-cat").value || null,
      by: cur.me || "",
      at: Date.now(),
      played: false,
      votes: {},
    };
    const d = cur.data;
    const dupe = d.items.find((it) => (item.appId && it.appId === item.appId) || it.title.toLowerCase() === title.toLowerCase());
    if (dupe) return toast(`“${dupe.title}” is already on the list.`);
    await change((d) => d.items.push(item));
    linkIn.value = titleIn.value = autoTitle = "";
    preview.hidden = true;
    linkIn.focus();
  });

  app.addEventListener("click", onGroupClick);
}

async function onGroupClick(e) {
  if (!cur?.data) return;
  const tabBtn = e.target.closest("[data-view]");
  if (tabBtn) {
    cur.view = tabBtn.dataset.view;
    renderTabs();
    renderAddForm();
    renderList();
    return;
  }
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  const id = btn.closest(".item")?.dataset.id;
  const d = cur.data;
  const item = id && d.items.find((it) => it.id === id);

  switch (act) {
    case "share": {
      const url = `${location.origin}${location.pathname}#/g/${encodeURIComponent(cur.slug)}`;
      try {
        await navigator.clipboard.writeText(url);
        toast(cur.meta.protected ? "Link copied. Send the password separately." : "Link copied.");
      } catch {
        toast(url);
      }
      break;
    }
    case "settings":
      return openSettings();
    case "whoami":
      return askWhoAmI(true);
    case "add-cat":
      return openDialog(
        `<form><h2>New section</h2><label for="nc">Name</label><input id="nc" name="name" required maxlength="40" autofocus placeholder="e.g. Co-op" />
          <p class="error"></p><div class="actions-end"><button value="cancel" formnovalidate>Cancel</button><button class="primary">Add section</button></div></form>`,
        async (f) => {
          const cat = { id: uid(), name: f.get("name").trim() };
          if (!cat.name) throw new Error("Give it a name.");
          await change((d) => d.cats.push(cat));
          cur.view = cat.id;
          if (cur?.data) renderGroup();
        }
      );
    case "vote": {
      if (!item || !cur.me) return;
      const n = Number(btn.dataset.n);
      const me = cur.me;
      return change((d) => {
        const it = d.items.find((x) => x.id === id);
        if (!it) return;
        it.votes ||= {};
        if (it.votes[me] === n) delete it.votes[me];
        else it.votes[me] = n;
      });
    }
    case "up":
    case "down": {
      const ids = visibleItems().map((x) => x.it.id);
      const i = ids.indexOf(id);
      const j = act === "up" ? i - 1 : i + 1;
      if (i < 0 || j < 0 || j >= ids.length) return;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      return reorder(ids);
    }
    case "played":
      return change((d) => {
        const it = d.items.find((x) => x.id === id);
        if (it) it.played = !it.played;
      });
    case "delete":
      if (item && (await confirmBox(`Delete “${item.title}”?`)))
        return change((d) => (d.items = d.items.filter((x) => x.id !== id)));
      return;
    case "edit":
      if (!item) return;
      return openDialog(
        `<form><h2>Edit ${esc(d.noun)}</h2>
          <label for="e-title">Name</label><input id="e-title" name="title" required maxlength="120" value="${esc(item.title)}" autofocus />
          <label for="e-link">Link</label><input id="e-link" name="link" value="${esc(item.url)}" placeholder="Steam link or any URL" />
          <label for="e-cat">Section</label>
          <select id="e-cat" name="cat"><option value="">No section</option>${d.cats
            .map((c) => `<option value="${esc(c.id)}" ${c.id === item.cat ? "selected" : ""}>${esc(c.name)}</option>`)
            .join("")}</select>
          <p class="error"></p>
          <div class="actions-end"><button value="cancel" formnovalidate>Cancel</button><button class="primary">Save</button></div></form>`,
        async (f) => {
          const title = f.get("title").trim();
          const linkText = f.get("link").trim();
          const p = parseLink(linkText);
          if (linkText && !p) throw new Error("That link doesn't look right.");
          await change((d) => {
            const it = d.items.find((x) => x.id === id);
            if (!it) return;
            it.title = title;
            it.cat = f.get("cat") || null;
            if (!linkText) Object.assign(it, { url: "", image: "", appId: "" });
            else if (p.url !== it.url) Object.assign(it, { url: p.url, image: p.image, appId: p.appId || "" });
          });
        }
      );
  }
}

function askWhoAmI(force = false) {
  if (dialog.open && !force) return;
  const d = cur.data;
  openDialog(
    `<form><h2>Who are you?</h2>
      <p class="muted">Pick your name so your votes and additions are yours. This is remembered on this device.</p>
      ${d.members.length ? `<div class="member-pick">${d.members.map((m) => `<button value="${esc(m)}" name="pick" formnovalidate>${esc(m)}</button>`).join("")}</div>` : ""}
      <label for="w-new">${d.members.length ? "Or join as someone new" : "Your name"}</label>
      <div class="row"><input id="w-new" name="name" maxlength="30" placeholder="Your name" /><button class="primary" value="join">Join</button></div>
      <p class="error"></p>
      ${force ? `<div class="actions-end"><button value="cancel" formnovalidate>Cancel</button></div>` : ""}
    </form>`,
    async (f, form, submitter) => {
      let name = submitter?.name === "pick" ? submitter.value : String(f.get("name") || "").trim();
      if (!name) throw new Error("Type your name.");
      const existing = d.members.find((m) => m.toLowerCase() === name.toLowerCase());
      if (existing) name = existing;
      else await change((d) => !d.members.includes(name) && d.members.push(name));
      cur.me = name;
      saveSession(cur.slug, { me: name });
      renderGroup();
    }
  );
}

function openSettings() {
  const d = cur.data;
  const draft = {
    name: d.name,
    noun: d.noun,
    nouns: d.nouns,
    mode: d.mode,
    members: [...d.members],
    cats: d.cats.map((c) => ({ ...c })),
  };

  const editList = (kind, items, label) =>
    `<ul class="edit-list" data-list="${kind}">${items
      .map(
        (v, i) =>
          `<li><input data-i="${i}" value="${esc(kind === "cats" ? v.name : v)}" maxlength="40" aria-label="${label} ${i + 1}" /><button type="button" class="icon danger" data-rm="${i}" aria-label="Remove">✕</button></li>`
      )
      .join("")}</ul>
    <div class="row"><input data-new="${kind}" placeholder="Add ${label.toLowerCase()}" maxlength="40" /><button type="button" data-add="${kind}">Add</button></div>`;

  const draw = () => {
    openDialog(
      `<form id="settings-form"><h2>Group settings</h2>
        <label for="s-name">Group display name</label>
        <input id="s-name" name="name" required maxlength="60" value="${esc(draft.name)}" />
        <label>What are you picking? (singular / plural)</label>
        <div class="row"><input name="noun" required maxlength="20" value="${esc(draft.noun)}" aria-label="Singular" /><input name="nouns" required maxlength="20" value="${esc(draft.nouns)}" aria-label="Plural" /></div>
        <fieldset style="margin-top:.75rem"><legend>Ordering</legend>
          <label class="radio"><input type="radio" name="mode" value="vote" ${draft.mode === "vote" ? "checked" : ""}/> Voting: everyone rates 1–5, highest average on top</label>
          <label class="radio"><input type="radio" name="mode" value="manual" ${draft.mode === "manual" ? "checked" : ""}/> Drag and drop</label>
        </fieldset>
        <fieldset><legend>Sections</legend>${editList("cats", draft.cats, "Section")}</fieldset>
        <fieldset><legend>Members</legend>${editList("members", draft.members, "Member")}
          <p class="muted small">Removing a member hides their votes from the ranking.</p></fieldset>
        <p class="muted small">${cur.meta.protected ? "🔒 Password protected. " : "Open group: anyone with the name can open it. "}The password is set when the group is created.</p>
        <p class="error"></p>
        <div class="actions-end">
          <button type="button" class="danger" data-forget>Forget on this device</button>
          <span style="flex:1"></span>
          <button value="cancel" formnovalidate>Cancel</button><button class="primary">Save</button>
        </div>
      </form>`,
      async (f) => {
        syncDraft();
        const names = new Set();
        for (const m of draft.members) {
          if (!m) throw new Error("Member names can't be empty.");
          if (names.has(m.toLowerCase())) throw new Error(`“${m}” is listed twice.`);
          names.add(m.toLowerCase());
        }
        if (draft.cats.some((c) => !c.name)) throw new Error("Section names can't be empty.");
        const patch = {
          name: f.get("name").trim(),
          noun: f.get("noun").trim(),
          nouns: f.get("nouns").trim(),
          mode: f.get("mode") === "manual" ? "manual" : "vote",
        };
        await change((d) => {
          Object.assign(d, patch);
          // Carry votes and "added by" over to renamed members so nobody loses their ratings.
          for (const it of d.items) {
            for (const [o, n] of Object.entries(draft.renamed)) {
              if (o in it.votes) {
                it.votes[n] = it.votes[o];
                delete it.votes[o];
              }
              if (it.by === o) it.by = n;
            }
          }
          d.members = [...draft.members];
          const keep = new Set(draft.cats.map((c) => c.id));
          d.cats = draft.cats.map((c) => ({ id: c.id, name: c.name }));
          for (const it of d.items) if (it.cat && !keep.has(it.cat)) it.cat = null;
        });
        if (draft.renamed[cur.me]) {
          cur.me = draft.renamed[cur.me];
          saveSession(cur.slug, { me: cur.me });
        }
        renderGroup();
      }
    );

    const form = $("#settings-form");
    form.addEventListener("click", async (e) => {
      const rm = e.target.closest("[data-rm]");
      const add = e.target.closest("[data-add]");
      if (rm) {
        syncDraft();
        const kind = rm.closest("[data-list]").dataset.list;
        draft[kind].splice(Number(rm.dataset.rm), 1);
        if (kind === "members") draft.memberOrigins.splice(Number(rm.dataset.rm), 1);
        draw();
      } else if (add) {
        syncDraft();
        const kind = add.dataset.add;
        const input = $(`[data-new="${kind}"]`, form);
        const v = input.value.trim();
        if (!v) return input.focus();
        if (kind === "cats") draft.cats.push({ id: uid(), name: v });
        else {
          draft.members.push(v);
          draft.memberOrigins.push(null);
        }
        draw();
        $(`[data-new="${kind}"]`, dialog)?.focus();
      } else if (e.target.closest("[data-forget]")) {
        forgetSession(cur.slug);
        dialog.close();
        location.hash = "#/";
      }
    });
    form.addEventListener("keydown", (e) => {
      const nw = e.target.closest("[data-new]");
      if (nw && e.key === "Enter") {
        e.preventDefault();
        $(`[data-add="${nw.dataset.new}"]`, form).click();
      }
    });

    function syncDraft() {
      for (const inp of $$('[data-list="cats"] input', form)) draft.cats[inp.dataset.i].name = inp.value.trim();
      for (const inp of $$('[data-list="members"] input', form)) draft.members[inp.dataset.i] = inp.value.trim();
      draft.name = $("#s-name", form).value;
      draft.noun = form.elements.noun.value;
      draft.nouns = form.elements.nouns.value;
      draft.mode = form.elements.mode.value;
      draft.renamed = {};
      draft.memberOrigins.forEach((orig, i) => {
        if (orig && orig !== draft.members[i]) draft.renamed[orig] = draft.members[i];
      });
    }
  };

  draft.memberOrigins = [...d.members];
  draft.renamed = {};
  draw();
}

// Broken cover art: try Steam's older CDN path once, then show the first letter instead.
document.addEventListener(
  "error",
  (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !img.classList.contains("cover")) return;
    if (img.dataset.app && !img.dataset.retried) {
      img.dataset.retried = "1";
      img.src = steamCoverFallback(img.dataset.app);
      return;
    }
    const div = document.createElement("div");
    div.className = "cover";
    div.textContent = img.dataset.letter || "?";
    img.replaceWith(div);
  },
  true
);

// ---------- start ----------
(async function start() {
  const badge = $("#mode-badge");
  badge.hidden = false;
  badge.textContent = isShared ? "shared" : "local mode";
  badge.title = isShared ? "Groups are stored online and shared." : "Groups are stored in this browser only.";
  try {
    be = await backend();
  } catch (e) {
    app.innerHTML = `<div class="panel"><h2>Could not load the backend</h2><p class="muted">${esc(e.message)}</p></div>`;
    return;
  }
  window.addEventListener("hashchange", route);
  route();
})();
