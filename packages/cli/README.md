# @bandwise/cli

The `bandwise` command. `bandwise run --local spec.json state.json` runs a question set spec on a state with no network and no key. `bandwise run --live`, `bandwise hook` and `bandwise report` run it against the real model with your own key and sum the receipts.

Bandwise is an independent product built on TypeSafe's System One models.

```sh
npx @bandwise/cli run --local spec.json state.json
TYPESAFE_API_KEY=... npx @bandwise/cli run --live spec.json state.json
npx @bandwise/cli --help
```

Documentation: https://docs.bandwise.dev. Source, examples and the template list: https://github.com/glacer06/bandwise-kit.

Apache License 2.0.
