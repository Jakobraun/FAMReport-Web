# Bundled browser libraries

Runtime requests use local files; no CDN requests are made by the app.

| File | Version | Source | License |
| --- | --- | --- | --- |
| xlsx-mini-0.20.3.js | SheetJS CE 0.20.3 mini build | https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.mini.min.js | Apache-2.0; see SheetJS-LICENSE.txt |
| fflate-0.8.2.mjs | fflate 0.8.2 browser ESM | https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js | MIT; see fflate-LICENSE.txt |

SHA-256 fingerprints of the vendored bytes:

```text
0cb353f830d7288385492c83d277b058ddeac664ca51cf1393aa1fd3e2b70939  xlsx-mini-0.20.3.js
8cc1f687e0159e977addb6b85e274dbd11e622cf151f4fcb7b85d49622ea43e7  fflate-0.8.2.mjs
4d2a38ac35cda06a555c84074a819d413339cd3691b822cae50f8f322fe01f64  SheetJS-LICENSE.txt
805f6cb28bb8b6d3a0badd83c93bccd9671fa01a3b4b92b7042b0743325ac243  fflate-LICENSE.txt
```

The mini build handles XLSX read/write. CSV parsing belongs to the application. fflate provides bounded streaming ZIP inspection before workbook parsing. Confirm provenance and update these fingerprints together when changing a dependency.
