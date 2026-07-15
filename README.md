# ★ Star Collector — Online (1–6 players)

A 45-second multiplayer stardust scramble. Every pilot joins from their own
machine by opening the game URL — no installs, no controllers, just a browser
and a keyboard.

## Quick start (local / LAN)

```bash
npm install
npm start
# → ★ Star Collector server on http://localhost:3000
```

1. Open http://localhost:3000, enter a call sign, leave the room code blank —
   a room is created and the URL updates to `/?room=ABCD`.
2. Share that link. Friends on the **same network** replace `localhost` with
   your machine's LAN IP (e.g. `http://192.168.1.42:3000/?room=ABCD`).
   Find your IP with `ipconfig` (Windows) or `ifconfig`/`ip a` (Mac/Linux).
3. The first player in the room is the **host (♦)** and presses ENTER to launch.
   1 player works for solo practice; up to 6 can join.

## Playing over the internet

Deploy anywhere that runs Node and supports WebSockets — the app is a single
process with zero external services:

- **Render / Railway / Fly.io / Glitch:** create a Node service from this
  folder; the server reads `PORT` from the environment automatically.
  Then share `https://your-app.onrender.com/?room=ABCD`.
- The client auto-selects `wss://` on HTTPS, so TLS just works.

## How to play

| Key | Action |
|---|---|
| ◄ ► or A / D | rotate |
| ▲ or W | thrust |
| SPACE | fire |
| ENTER | host: launch / play again |
| B | host: back to lobby (results screen) |

- **Collect stardust** ★ — most carried when the timer ends wins.
  Carrying more makes you accelerate faster (+2%/unit, capped +80%).
- **Avoid debris** — crashing stuns you and scatters 20% of your haul.
- **Shoot debris** — big rocks split, small rocks pop (and sometimes drop
  a stardust). Clear yourself a path.
- **Shoot rivals** — direct hits slow them to 40% for 2s and knock ★3 loose.
- **Power-up stars** (rare — grab them fast):
  - 🟢 Green — **Tri-shot**: three-way spread, 8s
  - 🟣 Purple — **Shotgun**: 6-pellet close-range blast, 8s
  - 🟠 Orange — **Invincible**: immune to rocks and shots, 6s
  - ⚪ White — **Laser**: piercing hitscan beam, 8s
  - 💗 Fuchsia — **Shrink**: 40% smaller hitbox for the rest of the round

## Tuning

Every gameplay number lives in the `CONFIG` object at the top of `server.js`,
with comments giving sane ranges — round length (15–60s works), magnet radius,
power-up rarity, weapon stats, debris density, and more. Restart the server to
apply changes; clients need only refresh.

## Architecture

- `server.js` — authoritative simulation at 60Hz; broadcasts 30Hz snapshots;
  rooms keyed by 4-letter codes; host-controlled round flow
  (LOBBY → SPLASH → PLAY → RESULTS). Clients only ever send *inputs*, so
  there's nothing to cheat with.
- `public/index.html` — canvas renderer with snapshot interpolation (~80ms
  buffer), synthesized Web Audio SFX, and all the juice (shake, particles,
  popups). Late joiners spectate live and drop in next round.

## Playtesting checklist

- [ ] Two machines on LAN: movement smooth on both (interpolation working)
- [ ] Shoot a large rock → splits into two; small rock → pops, sometimes drops ★
- [ ] Each power-up star grants the right effect with the right color
- [ ] Invincible ship plows through debris and ignores shots for 6s
- [ ] Shrunk ship visibly smaller and harder to hit for the whole round
- [ ] Laser pierces multiple ships/rocks in one line
- [ ] Host leaves → next player becomes host (♦) and can control the flow
- [ ] Player disconnects mid-round → their ship is removed, round continues
- [ ] Solo round starts with 1 player and reports a score
- [ ] 6-player room is readable: name tags + sorted scoreboard help tracking
