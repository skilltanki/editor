
<img src="https://raw.githubusercontent.com/skilltanki/game/main/public/logo.webp" height="175px">

A browser tank arcade that brings back the classic 2010 tank game: the angular hulls — Wasp, Hunter, Titan, Dictator — the boxy maps of hangars, garages and sand arenas, and the feel of a heavy machine on suspension that rocks over bumps, flies off ramps and shoves with its sides. Open the page and you are in a battle a few seconds later.

**No registration. No donations. Everything unlocked from the first second.** Pick a call sign, a tank and a map — and play. Alone against bots, or with friends in a password-protected room, or with strangers from the open rooms list.

This repository is the **mobile edition**: a PWA built for phones (touch controls, install to the home screen, gamepad support) that also runs on a desktop browser, plus two interchangeable backends for the lobby and the WebRTC signalling.

## Screenshots

### Mobile (PWA)

| Battle: joystick, Fire and supplies | Garage: hulls and turrets |
| --- | --- |
| ![Mobile battle](https://raw.githubusercontent.com/skilltanki/game/main/public/mob-14.webp) | ![Mobile garage](https://raw.githubusercontent.com/skilltanki/game/main/public/mob-19.webp) |

| New room: mode, bots, password | Map selection |
| --- | --- |
| ![Mobile new room](https://raw.githubusercontent.com/skilltanki/game/main/public/mob-20.webp) | ![Mobile map selection](https://raw.githubusercontent.com/skilltanki/game/main/public/mob-13.webp) |

### Desktop

| Beach map | Deck 9 in space | City map with ramps | Red versus blue on the hills | Supplies bar in battle |
| --- | --- | --- | --- | --- |
| ![Beach map](https://raw.githubusercontent.com/skilltanki/game/main/public/shot-1.webp) | ![Deck 9 in space](https://raw.githubusercontent.com/skilltanki/game/main/public/shot-3.webp) | ![City map with ramps](https://raw.githubusercontent.com/skilltanki/game/main/public/shot-4.webp) | ![Red versus blue on the hills](https://raw.githubusercontent.com/skilltanki/game/main/public/shot-5.webp) | ![Supplies bar in battle](https://raw.githubusercontent.com/skilltanki/game/main/public/shot-2.webp) |

| Battle over scoreboard | Tank selection | Map selection | Deathmatch: solo or multiplayer | Open battles list |
| --- | --- | --- | --- | --- |
| ![Battle over scoreboard](https://raw.githubusercontent.com/skilltanki/game/main/public/shot-6.webp) | ![Tank selection](https://raw.githubusercontent.com/skilltanki/game/main/public/shot-8.webp) | ![Map selection](https://raw.githubusercontent.com/skilltanki/game/main/public/shot-11.webp) | ![Deathmatch: solo or multiplayer](https://raw.githubusercontent.com/skilltanki/game/main/public/shot-9.webp) | ![Open battles list](https://raw.githubusercontent.com/skilltanki/game/main/public/shot-10.webp) |

## What is in the game

- **Modes:** Deathmatch, Team Deathmatch, Capture the Flag (bring the enemy flag home), Assault (carry your own flag to the enemy base), and Explore — drive around any map with no fight and no score.
- **7 hulls**, from the fast glass-cannon Wasp to the slow fortress Mammoth. **9 turrets**, each a different way to land damage: instant Smoky, bouncing Ricochet, piercing Railgun, rapid Twins, splash Thunder, the Firebird and Freeze jets (burn, chill), the Isida beam (drain enemies, heal allies), and the Shaft sniper with its charged aimed shot and visible laser.
- **Supplies for everyone, free and unlimited:** repair kit, double armour, double damage, nitro, nuclear energy. The only limit is the cooldown, the same for all. No shop.
- **50+ classic maps**, summer and winter variants, every one open from the start.
- **Balance tuned for skill:** damage spread and falloff, weakened double damage (a Railgun does not one-shot a medium hull even boosted), spawn protection, free spawn points.

## Single player with smart bots

Every mode plays offline too: pick a map, the number of bots (up to 11) and a difficulty, and the battle starts at once — no room, no waiting for anyone. The bots are not turrets on rails:

- **They aim like people.** A reaction delay before the first shot, a wandering aim error that grows against a moving target, a turret that has to traverse, a target lag — all tuned per difficulty (easy / normal / hard) and measured by kill-death ratio against a human.
- **They know the weapon in their hands.** Hitscan guns are fired on target, the Shaft is tapped up close and charged at range, the Isida heals a wounded teammate instead of shooting, jets are held while the target stays in the cone.
- **They drive the map.** A navigation grid is built from the map's geometry on load, paths are found and smoothed, a stuck tank backs out and the spot is remembered as blocked, cliffs and water are avoided, a flipped tank waits to be righted.
- **They play the mode.** Deathmatch bots hunt and pick vantage points; team bots share a blackboard, auction roles, escort and intercept flag carriers, run the flag routes, stage an attack together and ambush where the map hides them. Supplies are used with intent: nitro to chase, armour under fire, a kit when hurt.

## Multiplayer

Players connect to each other directly over **WebRTC** (a full mesh of data channels, up to 12 tanks a room); the backend only matches them and relays the signalling. One player — the **host peer** — is the authority for damage, deaths, respawns, flags, the score and the clock; the others simulate their own tank and replay the host's word. Hit claims are not taken on faith: the host clamps every hit to what that weapon can do, drops hits out of its reach and shots faster than its reload.

- **Rooms** are public (in the list, filtered by mode) or private (password, marked with a lock). Up to 12 players per room, bots can be added and are spread over the players' phones.
- **Host migration:** when the host leaves, the next player becomes the host, the clock continues from the last value, the bots move to the remaining players.
- **Reconnect:** a dropped connection or a page reload brings a player back to the same tank (a bot drives it meanwhile); a player gone for good is replaced by a bot.
- **ICE out of the box:** public STUN plus TURN credentials minted on the fly, so phones behind carrier NAT connect too. On one Wi-Fi the phones talk to each other with no internet at all.

## Controls

Three ways in, all working at once:

- **Touch** — a floating joystick on the left half, Fire, turret, centre, camera and self-destruct buttons on the right, supplies on the HUD.
- **Keyboard** — WASD or arrows to drive, Z/X turret, C centre, Space fire, Q/E camera, 1–5 supplies, 0 self-destruct (hold), Tab score table, Escape pause.
- **Gamepad** (standard mapping, Bluetooth or USB) — left stick drives, right stick turns the turret and tilts the camera, R1 or Cross fires (held: the Shaft's aim), D-pad clockwise = supplies 1–4, R3 nuclear, L3 held = self-destruct, Start pause, Select score table. In the menus the D-pad and left stick are the arrows, Cross is Enter, Circle is Escape. A virtual pad for testing opens with `?gamepad=sim` in development.
