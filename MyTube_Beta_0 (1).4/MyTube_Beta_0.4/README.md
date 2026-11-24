# MyTube Beta 0.4

Privacy-first YouTube frontend with a local, time-decaying recommendation engine. No server, no account.
Data lives in `~/.config/mytube/`: `profile.json` (settings, history, subscriptions, playlists, ratings, pins),
`cache.json` (video cache) and `app.log` (technical log, rotated at 2 MB).

## Run
    npm install
    npm start          # add -- --no-sandbox or -- --ozone-platform-hint=auto if needed on your system
    npm test           # unit tests + a smoke test of the main process (fake Electron, no network)

## Build AppImage
    npm run dist       # dist/MyTube_Beta_0.4.AppImage

## Playback
YouTube blocks many public Piped instances. Install yt-dlp as a fallback (it uses Node.js as its JS runtime):

    mkdir -p ~/.local/bin
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o ~/.local/bin/yt-dlp
    chmod +x ~/.local/bin/yt-dlp

Settings -> Test yt-dlp checks it. Quality can be Auto (adapts to stalls and player size) or fixed.

## Debugging
Logs tab: filter by level/source, "Copy diagnostics" (versions, settings without history, instance table, recent log),
"Run self-test" (each Piped endpoint per instance + yt-dlp, with timings). IDs are shortened in the log unless
Settings -> Debug -> full IDs is on. Search terms, titles and watch history are never logged.

## New in Beta 0.4
Feed no longer locks onto one channel (cap per channel, subscription share, freshness, less trust in tiny histories);
1000+ subscriptions refresh through Piped's multi-channel feed (RSS as optional fallback); regions list (US, NO, GB);
old settings are migrated (Auto quality is now the default); sidebar mode has no top bar, can sit left or right and
auto-collapse; MyTube draws its own window bar (system bar available); old page clears at once and a spinner shows after 3 s;
yt-dlp suggestion + one-click verified install; Developer mode hides Instances, Logs and advanced options by default;
ignore list ("remove this from the algorithm"); quality list sorted by resolution; yt-dlp 'no videos tab' channels handled.

See PROJECT.md for the full project summary.
