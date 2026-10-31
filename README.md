# APEX TV (TizenBrew module)

Live TV, guide, movies, series and Jellyfin library app for a Samsung TV running [TizenBrew](https://github.com/reisxd/TizenBrew). The UI is in `app/`; channel
data and streams come from a self-hosted server on the home network (192.168.0.176), so it only works inside that LAN.

Add in TizenBrew: Module Manager, "Add GitHub Module", enter `xxdjhugoxx/apex-tv-module`.

Remote: arrows move, OK plays, Back goes back. While watching: Up/Down or CH+/CH- change channel, OK shows info,
Left/Right reach Favorite / Version / Channel list, yellow toggles a favorite, Stop closes the player.
Movies and series: OK opens the page (Resume / Play, seasons and episodes); while playing, OK pauses, Left/Right
jump 10 s, Up/Down or rewind/fast-forward jump 1 min, Back returns to the page.
Number keys jump to a channel; in the Guide OK plays the channel. Profiles and the adult-content PIN are kept on
the TV itself.

Generated from the APEX TV source; do not edit here. `app/vendor/mpegts.js` is mpegts.js 1.8.0 (Apache-2.0, see
`app/vendor/mpegts.LICENSE`).
