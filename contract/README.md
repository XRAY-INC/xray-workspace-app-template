# Contract vectors

These files are the XRAY Workspace side of the app contract, written down as
data so the apps in this repository can be tested against it without the
workspace's source.

| File                   | What it holds                                                                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace-v1.json`    | Identity tokens minted by the workspace's real minter, with the verdict each should get; the embed message names; the theme vocabulary, patterns and real theme messages for both modes; the workspace's verdicts on deep links and markdown |
| `manifest.schema.json` | The schema the workspace validates `GET /api/v1/manifest` against at registration, as JSON Schema (draft 2020-12)                             |

**Do not edit them by hand.** They are generated from the workspace's code by
its `scripts/export-app-template-contract.ts`, and regenerated when that code
changes. A change here is a contract change: the tests in `examples/` say
whether the apps still agree with it.

The token key in `workspace-v1.json` (`identityToken.vectorKey`) is a fixed,
test-only value. It signs these vectors and nothing else.

## Using the manifest schema

Any JSON Schema 2020-12 validator works. With [Ajv](https://ajv.js.org/):

```js
import Ajv2020 from "ajv/dist/2020.js";
import schema from "./contract/manifest.schema.json" with { type: "json" };

const validate = new Ajv2020({ strict: false }).compile(schema);
if (!validate(myManifest)) console.error(validate.errors);
```

Two rules are enforced at registration that JSON Schema cannot express:
`service` must equal the slug you register, and
`certification.recordPathTemplate`, when present, must contain `{id}`.
