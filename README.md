# Elissa Revision – setup guide

Elissa Revision turns revision notes (a photo, PDF, Word document or typed notes) into a rap, pop song, chant or chilled track. Each track has lyrics that play along to a beat with the words highlighted as they're spoken, a key facts list and a quick quiz. Tracks are saved to her library and work offline once made.

Your Firebase project `elissa-kawa` is already wired in. The steps below take about 20 minutes.

## What's in the folder

| Path | What it does |
|---|---|
| `public/` | The app itself (this is what gets hosted) |
| `functions/index.js` | The secure server function that holds your API key and calls Claude |
| `firestore.rules` | Security rules – each person only sees their own tracks |
| `firebase.json`, `.firebaserc` | Tells Firebase what to deploy and where |

## 1. Upgrade the Firebase project to Blaze

Cloud Functions (which keep the API key hidden) need the pay-as-you-go **Blaze** plan. For one person's use it will almost certainly stay within the free allowance.

1. In the Firebase console, click **Upgrade** (bottom left, next to "Spark").
2. Choose **Blaze** and link a billing account.
3. When prompted, set a **budget alert** – £5 is plenty.

## 2. Turn on sign-in and create Elissa's account

1. Go to **Security → Authentication → Get started**.
2. Under **Sign-in method**, enable **Email/Password**.
3. Under **Users**, click **Add user** and create Elissa's login (and one for yourself if you'd like).

There's no public sign-up screen, so only accounts you create can use the app.

## 3. Set the Firestore rules

Replace the current rules (the ones that block everything) with the contents of `firestore.rules`, then click **Publish**. The deploy in step 6 also does this automatically, so either way works.

## 4. Get your Claude API key

1. Sign up at the Claude Platform (see docs.claude.com/en/api/overview for the current link).
2. Add a payment card and some prepaid credit, and set a monthly spend limit.
3. Create an API key called "Elissa Revision" and copy it. Keep it private – never paste it into the app files.

## 5. Install the tools (one-off)

On your Mac, open Terminal:

```bash
# Install Node.js 20 or later from nodejs.org if you don't have it, then:
npm install -g firebase-tools
firebase login
```

## 6. Store the key and deploy

From inside the `elissa-revision` folder:

```bash
cd functions && npm install && cd ..
firebase functions:secrets:set ANTHROPIC_API_KEY
# paste the key when asked, then press Enter

firebase deploy
```

When it finishes, it prints a **Hosting URL** like `https://elissa-kawa.web.app`. That's the app.

If the deploy mentions enabling APIs (Cloud Build, Artifact Registry, Secret Manager), say yes – it's normal on the first run.

## 7. Put it on her home screen

- **iPhone/iPad:** open the link in Safari → Share → **Add to Home Screen**.
- **Android:** open in Chrome → menu (⋮) → **Install app**.
- **Mac/PC:** open in Chrome or Edge → click the install icon in the address bar.

Tap the speaker/volume up the first time – on iPhone, make sure the silent switch is off, or the beat won't play.

## Hosting on GitHub Pages instead (optional)

Firebase Hosting is simplest, but the `public` folder also works on GitHub Pages as-is. If you do this, add your GitHub Pages domain (for example `orngroup.github.io`) under **Authentication → Settings → Authorised domains**. You still need step 6 for the function.

## Handy settings

In `functions/index.js`:

- `DAILY_LIMIT` – tracks per day per person (currently 25).
- `MODEL` – the Claude model used.

After changing anything, run `firebase deploy` again. After changing files in `public/`, also bump `CACHE` in `public/sw.js` (for example `elissa-v2`) so her phone picks up the update.

## Costs at a glance

- **Claude:** each track is one request; typically a few pence at most, less for short notes.
- **Firebase:** sign-in, the database, hosting and the function all have free monthly allowances well above family use.

## If something goes wrong

| What you see | What to do |
|---|---|
| "The track maker is busy" | Check the API key has credit. Run `firebase functions:log` to see the exact error. |
| Sign-in fails on a GitHub Pages link | Add the domain under Authentication → Authorised domains. |
| No sound on iPhone | Turn the silent switch off and turn the volume up. |
| Voice sounds American | The app picks a British voice when the device has one. On iPhone: Settings → Accessibility → Spoken Content → Voices → English → download a UK voice. |
| Old version showing | Close and reopen the app; if still old, bump `CACHE` in `sw.js` and redeploy. |
