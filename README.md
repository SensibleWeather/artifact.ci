<!-- codegen:start {preset: custom, source: ./scripts/codegen.js, export: generateReadme} -->
# artifact.ci

A wrapper around the `actions/upload-artifact` action which makes it possible to view the uploaded artifact in a browser.

It's a drop in replacement for the `actions/upload-artifact` action, so you can use it in the same way:

```diff
name: CI
on: [push]
jobs:
  run:
    steps:
      - uses: actions/checkout@v4
      - run: npm install
      - run: npx playwright test --reporter html
-     - uses: actions/upload-artifact@v4
+     - uses: mmkal/artifact.ci/upload@main
        if: always()
        with:
          name: e2e-test-report
          path: playwright-report
```

This will print a link to the artifact in your workflow run output, which you can click to view in your browser:

![playwright report](./public/reports/playwright.png)

## Why?

This should really be a feature built into GitHub, but [it isn't](https://github.com/actions/upload-artifact/issues/14). It is built into some other CI providers like CircleCI.

## Recipes

Here are some high-level guides for how to get useful HTML outputs from various tools:

### Testing frameworks

#### Playwright

HTML reporting is built in to Playwright. It's interactable, and renders detailed failure information, step-by-step traces including console logs, network calls, as well as screenshots and videos. Just add `reporter: 'html'` to your `playwright.config.ts`, run `playwright test --reporter html` via the CLI, or see [playwright docs](https://playwright.dev/docs/test-reporters#html-reporter) to customize the output folder. Then upload an artifact and print the URL:

```yaml
- run: npx playwright test
- uses: mmkal/artifact.ci/upload@main
  if: always()
  with:
      name: playwright
      path: playwright-report
```

![Playwright example](/public/reports/playwright.png)

#### Vitest

Vitest has a sort-of builtin report. Just run `vitest --reporter html` via the CLI, or see [vitest docs](https://vitest.dev/guide/reporter.html#html-reporter). You may be prompted to install the `@vitest/ui` package. Then just upload the artifact:

```yaml
- run: npx vitest
- uses: mmkal/artifact.ci/upload@main
  if: always()
  with:
      name: vitest
      path: vitest-report
```

![Vitest example](/public/reports/vitest.png)

#### Jest

First install `jest-reporters-html`

```bash
npm install --save-dev jest-reporters-html
```

Then you can run jest with `npx jest --reporters jest-reporters-html` or add it to your jest.config.js:

```js
module.exports = {
  reporters: ['default', 'jest-reporters-html'],
}
```

```yaml
- run: npx jest
- uses: mmkal/artifact.ci/upload@main
  if: always()
  with:
      name: jest
      path: jest_html_reporters.html
```

![Jest example](/public/reports/jest.png)


#### ava

There's no great HTML reporter for AVA, but there's an ok-ish one for tap:

```bash
npm install tap-html --save-dev
```

```yaml
- run: npx ava --tap | npx tap-html --out output.html
- uses: mmkal/artifact.ci/upload@main
  if: always()
  with:
      name: ava
      path: output.html
```

![AVA example](/public/reports/ava.png)

#### mocha

Mocha's [doc](https://mochajs.org/#doc) reporter outputs simple HTML. Their documentation has some pointers on how to add styling to the output.

```yaml
- run: npx mocha --reporter doc > output.html
- uses: mmkal/artifact.ci/upload@main
  if: always()
  with:
      name: mocha
      path: output.html
```

![Mocha example](/public/reports/mocha.png)

### Other languages

#### python

[pytest-html](https://pypi.org/project/pytest-html) outputs a useful document.

```bash
pip install pytest-html
```

```yaml
- run: pytest tests --html report/index.html
- uses: mmkal/artifact.ci/upload@main
  if: always()
  with:
      name: pytest
      path: output.html
```

![pytest example](/public/reports/pytest.png)

#### go

Go's default test output can be piped to [go-test-report](https://github.com/vakenbolt/go-test-report).

```bash
go get github.com/vakenbolt/go-test-report
go install github.com/vakenbolt/go-test-report
```

```yaml
- run: go test -json | go-test-report
- uses: mmkal/artifact.ci/upload@main
  if: always()
  with:
    name: go
    path: test_report.html
```

![go example](/public/reports/go.png)


## Limitations

For now, it's limited to whitelisted GitHub organizations. In future, I'll open it up to all users, likely based on GitHub sponsorship. It will also be free for open-source projects that don't have commercial sponsors.

## Self-host

The code is open-source, so you can self-host it if you want to (e.g. to run on a private network, or to use it without sponsoring me, or to use a different blob storage provider, or to add extra features etc.). Here's how:

- Clone the repository
- Deploy to Vercel - which will automatically detect how to build and deploy the server. You should also be able to use any other platform that supports Next.js.
- You'll need to set the `ALLOWED_GITHUB_OWNERS` environment variable to a comma-separated list of GitHub organizations that are allowed to upload artifacts.
- Blob storage setup:
   - This project uses `@vercel/blob`, but in theory you may be able to use a service that wraps another blob storage provider like AWS, Azure or Cloudflare's offerings, to make them usable with the `@vercel/blob` SDK.
   - Set the `STORAGE_ORIGIN` environment variable to the URL of the storage service you're using.
   - Set the `BLOB_READ_WRITE_TOKEN` environment variable to a token that has read/write access to the storage service.
- Auth setup:
   - Add an environment variable `AUTH_SECRET` to your server deployment.
   - Create a GitHub OAuth app
   - Set the callback URL to `https://<your-domain>/api/auth/callback/github`
   - Set the `AUTH_GITHUB_ID` and `AUTH_GITHUB_SECRET` environment variables to the values from the GitHub OAuth app.
<!-- codegen:end -->