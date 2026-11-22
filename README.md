# watplay

Decide what to play next, together.

watplay is a small web app for a group of friends to keep a shared "what should we play next?" list. It runs as a static site on GitHub Pages, with no build step.

## Features

- **Groups.** Each group has a name, its own members, its own sections and its own list. Open a group by typing its name, or share a link.
- **Optional password.** A group can be password protected when it is created. Without the password its data can't be found or read (see [How the password works](#how-the-password-works)).
- **Sections** for different kinds of games (Co-op, Strategy, Quick rounds, …), plus an overall **Play next** list that shows everything, and a **Played** list.
- **Two ways to order:** switch between them in the group settings.
  - **Voting:** every member rates each game 1–5. The highest average goes to the top. Ties go to the game with more votes. The list shows who still has to vote.
  - **Drag and drop:** drag games into order (or use the ↑ ↓ buttons on touch screens).
- **Add by Steam link or by name.** Pasting a Steam store link fills in the name from the link and shows the cover art. Any other link (or none) works too.
- **Not just for games.** In settings, change "game / games" to "movie / movies", "book / books" or anything else, and the whole app uses that word.
- Works on phones, and follows your light or dark system theme.

## Deploy it

There are two parts: turning on GitHub Pages, and (once) creating a free Firebase project so everyone in a group sees the same data.

### 1. Turn on GitHub Pages

1. On GitHub, open the repository's **Settings → Pages**.
2. Under **Build and deployment**, set **Source** to *Deploy from a branch*, pick the `main` branch and the `/ (root)` folder, and click **Save**.
3. After a minute the site is live at `https://<your-username>.github.io/watplay/`.

At this point the app already works in **local mode**: groups are saved in that one browser only. That's good for trying it out. To share groups with friends, do step 2.

### 2. Set up the shared backend (free, about 5 minutes)

1. Go to <https://console.firebase.google.com>, click **Create a project**, give it any name. Google Analytics is not needed.
2. In the project, open **Build → Firestore Database → Create database**. Pick a location near you and start in **production mode**.
3. Open the **Rules** tab of Firestore, replace everything with the contents of [`firestore.rules`](firestore.rules) from this repo, and click **Publish**.
4. Go to **Project settings** (gear icon) → **Your apps** → click the **Web** icon (`</>`), give it a nickname, and register it (no hosting needed).
5. Firebase shows a `firebaseConfig` block. Copy its values into [`js/config.js`](js/config.js), commit and push.

Reload the site: the badge next to the logo now says **shared** instead of **local mode**.

The Firebase web config is meant to be public, so it is fine to commit it. What protects the data are the rules from step 3.

### Run it locally

Any static file server works, for example:

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

## Why Firebase?

The app needs somewhere to store shared data that a static GitHub Pages site can talk to directly, for free. Firebase Firestore fits best for this:

- **Free for this size.** The free Spark plan allows 50,000 reads and 20,000 writes per day and 1 GB of storage, far more than a group of friends will use. No credit card is needed.
- **Never pauses.** Supabase's free tier pauses a project after a week without activity, which is likely for a two-person group between game nights.
- **Live updates.** When a friend votes or adds a game, everyone's list updates instantly without reloading.
- **Talks to the browser directly**, with security rules enforced on Google's servers, so there is no server of our own to run.

Other options considered: a GitHub repo as a database (needs every user to have a GitHub token), JSON bin services (no real access control, rate limits), and Supabase (pauses when idle).

## How the password works

There is no login. Instead:

- `groups/{name}` is a small public entry that says a group exists and whether it has a password.
- The group's actual data lives at `spaces/{key}`, where `key = SHA-256("watplay:v1:" + group name + ":" + password)`.
- The security rules allow reading a space only by its exact key and forbid listing spaces, so without the password the key can't be computed and the data can't be found.

Each browser remembers the key after a successful login, so friends type the password once per device. "Forget on this device" in the settings removes it.

This keeps casual visitors out. It is not bank-grade security: anyone who knows the password can read and change everything in that group, and an open group (no password) can be changed by anyone who knows its name. The password is chosen when the group is created and can't be changed later in this version.

## Project layout

```
index.html          page shell
styles.css          styles (light and dark)
js/app.js           the app: routing, group view, voting, drag and drop, settings
js/store.js         storage layer (Firestore, or localStorage in local mode)
js/links.js         Steam / link parsing
js/config.js        your Firebase config goes here
firestore.rules     security rules to paste into Firebase
vendor/             SortableJS (drag and drop, MIT licensed)
```

All of a group's data is one Firestore document, changed in transactions so two people editing at once don't overwrite each other.

## License

GPL-3.0, see [LICENSE](LICENSE).
