# Security policy

## Reporting a vulnerability

Please report security problems privately. Use GitHub private vulnerability reporting on this repository: open the **Security** tab and choose **Report a vulnerability**. Do not open a public issue, pull request or discussion for a security problem.

Include what you found, the package and version, and the steps to reproduce it. We will reply in the advisory thread, agree on a fix and a disclosure date with you, and credit you in the advisory unless you ask us not to.

## Supported versions

Fixes go into the latest release of each package (`@bandwise/core`, `@bandwise/system-one-client`, `@bandwise/templates`, `@bandwise/cli`). Upgrade to the newest version to get them.

## Keys

The kit never needs a Bandwise key. `bandwise run --local` makes no network call and needs no key at all. If you use `@bandwise/system-one-client` with your own TypeSafe, OpenRouter or Vercel AI Gateway key, keep that key on your server and out of browser bundles, logs and chat tools.
