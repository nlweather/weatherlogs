# Weather station site

`index.html` is the whole website. A small script (`scripts/update-history.mjs`) saves every finished day's stats
into `data/history-<station>.json`, so the By month and By year views load from one file instead of fetching a
day at a time from Ecowitt and Weather Underground. A GitHub Action runs the script every night and commits the
new day; Netlify redeploys when that commit lands.

```
index.html                        the page
data/history-summerville.json     created by the script (one small record per day)
scripts/day-stats.mjs             how a day's stats are worked out (same logic as the page's By day view)
scripts/update-history.mjs        fetches missing days and writes the files
scripts/stations.json             station ids and the first day to collect
.github/workflows/update-history.yml   the nightly job
```

## One-time setup

1. **Put these files in a GitHub repository** (keep the folder layout above).
2. **Add your keys as secrets**: repository Settings > Secrets and variables > Actions > New repository secret.
   For Summerville (the station id `summerville` in capitals, then the name):

   | Secret | Value |
   |---|---|
   | `SUMMERVILLE_ECOWITT_APP_KEY` | Ecowitt application key |
   | `SUMMERVILLE_ECOWITT_API_KEY` | Ecowitt API key |
   | `SUMMERVILLE_ECOWITT_MAC` | station MAC, e.g. `BC:FF:4D:10:EC:AD` |
   | `SUMMERVILLE_WU_API_KEY` | Weather Underground API key |
   | `SUMMERVILLE_WU_STATION_ID` | e.g. `ISTJOH60` |

   St. Bernard's uses the same five names starting with `STBERNARDS_`. A station with no secrets is skipped.
3. **Set the first day to collect** in `scripts/stations.json` (`historyStart`). Summerville is `2022-05-01`.
   Change St. Bernard's to the day that station started reporting.
4. **Run the first backfill**: Actions tab > "Update weather history" > Run workflow. Try it once with `max` set to
   `20` to check the keys work, then run it again with `max` empty. The full backfill is one request per day,
   spaced out to respect the services' limits, so roughly an hour for four years. If it is cut short, run it
   again; it carries on where it stopped.
5. **Netlify**: Add new site > Import from Git > pick the repo. Leave the build command empty and set the publish
   directory to `/`. Every nightly commit redeploys the site.

After that it runs by itself every night (about 4 a.m. Newfoundland time) and adds the previous day.

## Good to know

- Days up to 90 days old are collected from Ecowitt (5-minute readings). Older days come from Weather Underground
  (the same routing as the Raw daily data view). Today is never saved, because it isn't finished; the page
  loads today and any day not yet in the file live from the services as before.
- The files are always metric. The page converts to Imperial when you switch units.
- If a day fails (a service was down or rate-limited) it simply isn't saved, and the next run tries it again.
  A day that has no data at all is saved as empty after three days so it isn't retried forever.
- If you change how a statistic is worked out in `index.html`, make the same change in `scripts/day-stats.mjs`,
  raise `RECORD_VERSION` in it, and run the backfill again (a version change starts the files over).
- Run it on your own computer: set the secrets as environment variables, then `node scripts/update-history.mjs`
  (Node 18 or newer, no packages to install). `--max 20` stops after 20 days; `--station summerville` does one station.
- The keys in the page's `CONFIG` are only used for live data (today, the By day and Raw daily data views).
  The script never reads them; it uses the secrets above.
