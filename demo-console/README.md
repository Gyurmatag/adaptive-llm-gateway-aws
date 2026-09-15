# demo-console

The stage UI. Runs the five live demos so nothing has to be typed as a curl in
front of an audience.

```bash
cp .env.example .env.local     # fill in from ../config/.env.deployed
npm install
npm run dev                    # http://localhost:3100
```

## Why this is a separate app from `dashboard-web`

`dashboard-web` is `output: "export"` - a fully static bundle on Amplify, with
no server. That is deliberate: Amplify lists Next.js streaming as unsupported,
and a static export removes its compute provider from the picture entirely.

This console needs the opposite. Every call it makes to the gateway carries the
master key, and **a key must never reach a browser bundle**, so each demo runs
in a route handler on the server:

| Route | Demo |
|---|---|
| `/api/chat` | streaming chat, AI SDK, model switchable per message |
| `/api/fanout` | Demo 1 - one prompt, three vendors, in parallel |
| `/api/cache` | Demo 2 - ask cold, then reworded; returns the similarity |
| `/api/arm` | Demo 4 - the kill switch, via the gateway's admin endpoint |
| `/api/budget` | Demo 5 - mint a capped key and spend it |
| `/api/state` | live posteriors and spend, proxied |

It runs on the laptop and talks to the **production** gateway. That is also the
more reliable choice on stage: one less network hop than serving the UI itself
over CloudFront.

## Demo 2 needs the semantic cache

Use a country you have not asked today. Anything already cached returns instantly
on the first ask too, and the demo shows no contrast - which looks like a failure
while being the cache working perfectly.
