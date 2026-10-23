# Genepedia API

The live Genepedia and Gravepedia backend is the JavaScript Worker in
[`sites-worker/`](sites-worker/README.md), hosted through ChatGPT Sites at
`https://api.genepedia.org`. New clients use the versioned API bases:

- `https://api.genepedia.org/v1/genepedia`
- `https://api.genepedia.org/v1/gravepedia`

Its endpoint contract is documented in
[`sites-worker/openapi.json`](sites-worker/openapi.json). The Worker uses
Sites D1 and R2 as the source of record for runtime data and files. GitHub
is retained for sign-in and source/history archives; repository access is not
required for website reads, edits, review, media or statistics.

The PHP files in this repository are retained as historical source and are
not deployed as the production API. Do not upload them to Afrihost or configure
new frontend code to call them. The supported Sites release workflow, runtime
secrets, route list, and validation steps are documented in the Worker README.

`COPY_TO_SERVER.md` is retained for historical reference only.
