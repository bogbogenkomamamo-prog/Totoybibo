# Celestial Lite

Auto-reply + self-react lang. Walang nickname changer, walang GC name lock, hindi nagre-react sa message ng iba. Mas kaunti ang galaw ng account, kaya mas malaki ang tsansang tumagal ang login.

## Deploy (Railway)
1. Push sa GitHub → New Project → Deploy.
2. **Variables:** `DATA_DIR=/app/data`. Walang dashboard password by default. Kung gusto mong i-lock, magdagdag ng `ADMIN_PASSWORD`.
3. **Volume:** i-mount sa `/app/data`. Dito sine-save ang cookie na ni-refresh ng bot; kapag wala, mawawala ito sa bawat redeploy.
4. Buksan ang domain → paste cookie → Save & connect → pili ng GC → Start.

## Ano ang ginagawa
- Sumasagot sa chat gamit ang `replies.json` (pinipili ayon sa uri ng message), may typing indicator at human delay. Default na Fast (~1–3s).
- **Self react:** nire-react lang ang sarili niyang reply (😆😂🤣💀😭) pagkalipas ng 0.5–2.2s.
- Mark as seen, random skip, cooldown kada tao, hourly/daily cap, quiet hours.

## Para tumagal (hanggang 1 buwan)
Walang makapag-guarantee nito, si Facebook ang nagpapasya. Pero:
- Auto-save ng bagong cookie (pag-login, bawat 5 min kung may pagbabago, at pag-shutdown).
- Kapag naputol ang listener, nire-relisten muna sa parehong login. Kapag checkpoint/expired, **humihinto ang auto-retry** at may pulang banner.
- Auto-resume pag nag-restart ang server. May `/health` para sa Railway.
- Cookie mula sa browser session na hindi mo na gagalawin (huwag mag-log out doon, huwag gamitin sa ibang lugar).
- Isang deploy region lang, at huwag palaging mag-redeploy.
- Gumamit ng quiet hours (hal. 01:00–07:00) at katamtamang limits.
- Kapag lumabas ang pulang banner, i-clear ang checkpoint sa phone mo at mag-paste ng bagong cookie.

## Stealth profile (v2.2)
- Boring/neutral replies lang (`replies.json`): walang opinyon, walang agree/disagree (walang "ok", "sige", "oo", "noted" at kahawig), walang tanong na mag-aanyaya ng usapan, walang tease.
- Mababang footprint: Normal speed (medyo pinabilis), skip ~45%, 60s cooldown/tao, max 3 reply/5 min kada GC, 10/oras, 60/araw, self-react 15%, quiet hours 00:30–07:30.
- Sa unang start ng bagong bersyon, ina-apply ito sa naka-save na `config.json` (isang beses lang). Pagkatapos, ang dashboard settings mo na ang masusunod.

## Asar mode (replies.json, 1000 replies)
- 1000 unique na pang-asar lang: walang agree, walang compliment, walang tanong. Mild banter lang, walang mura, walang pang-iinsulto sa itsura, pamilya, kasarian o paniniwala.
- Na-match pa rin sa uri ng mensahe (tawa, sigaw, tanong, paulit-ulit na kwento, pagsang-ayon).
- Mas mapapansin ang bot kapag nang-aasar, kaya kung gusto mo pa ring stealth, ibaba ang hourly/daily limits sa dashboard.

## Auto health watchdog + auto debuff (v2.3)
- **Watchdog (bawat 1 min):** inaayos nito ang stuck reply lock, hung na login, nawalang reconnect timer, nawalang listener, at listener na walang event nang 3 oras (sa parehong login lang, hindi nagla-login ulit).
- **Auto debuff:** kapag 3 sunod na pumalya ang send, o may hint ng limit/spam/block mula sa Facebook, kusang bumabagal ang bot (level 1–3: mas mababang caps, mas maraming skip, mas mahabang cooldown). Sa level 3, 2 oras na pause. Kusa ring bumababa ang level kada 3 oras na walang problema.
- Makikita ang debuff level at mga auto-fix sa Session health ng dashboard. Ang checkpoint/expired na cookie ay hiwalay pa ring hinahawakan (humihinto ang retry at may pulang banner).

## Auto heal (v2.4)
Kusa nang aayusin ng bot ang sarili niyang errors. Kinikilala niya muna ang uri ng error, tapos ang tamang fix ang ginagawa:
- **Network errors** (ECONNRESET, timeout, DNS): walang ginagawang drastic, may backoff retry na. Hindi ito binibilang na problema ng account.
- **Paulit-ulit na code error** (3x pareho sa 10 min) o iba pang error (6x): connection reset sa parehong cookie, hindi hihigit sa isa kada 30 min.
- **Cookie na tinanggihan:** sinusubukan muna ang naunang gumaganang cookie (`appstate.backup.json`) bago magpakita ng pulang banner.
- **Sirang `config.json`:** kusang ibinabalik mula sa `config.json.bak` (sine-save ito sa bawat save). **Sirang `replies.json`:** gumagamit ng built-in na fallback imbes na mag-crash.
- **Sobrang memory** (default 600MB, `MAX_RSS_MB`) o **10 fatal errors sa 10 min:** clean na self-restart (naka-save muna ang cookie). `restartPolicyType` ay `ALWAYS` na sa `railway.json`, kaya bumabalik ito palagi.
- Hindi niya ginagalaw ang checkpoint/expired na cookie. Iyon ay kailangan pa ring ayusin mo sa phone at mag-paste ng bagong cookie.
- Lahat ng auto-fix ay nakalista sa Activity at may bilang sa Session health ng dashboard.

## Mabilis na login (v2.5)
- Kusang nagko-connect pagka-start ng server (kung may naka-save na cookie), at agad pagka-Save & connect sa dashboard.
- Mas mabilis ang reconnect: 3s, 6s, 12s, 24s... (dati 8s), may jitter, hanggang 5 min lang. Hindi ito nagre-retry sa checkpoint/expired na cookie.
- Mas maikli ang hintay ng auto-heal (1–4s) at ng hung na login (60s).
- Dashboard: lumalabas na ang **CONNECTING…**, nagre-refresh kada 1s habang offline, at kusang lumalabas ang listahan ng GC pagka-online.
- Ang mismong handshake sa Facebook ay hindi namin kontrolado, kaya ang nabawasan ay ang paghihintay sa paligid nito.

## Env (optional)
`ADMIN_PASSWORD` (optional lock), `DATA_DIR`, `BOT_TZ` (default `Asia/Manila`), `MAX_RSS_MB` (default 600), `BANAT_TYPO_RATE`, `BANAT_SHORTHAND_RATE`, `BANAT_HESITATION_RATE`.

> Labag sa Terms ng Facebook ang unofficial automation; may risk na ma-restrict ang account.
