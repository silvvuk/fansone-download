# fansone-download

> A fansone subscription downloader based on playwright for login and cookie retrieval, axios for API requests,
got for chunk downloading, and node-av (ffmpeg) for file format detection and merging.

## How to use?

First, you need node >= 22, because you need to install the node-av package (it's a node binding for
ffmpeg with pre-built binaries).

Then

```sh
corepack enable pnpm
pnpm i
pnpm start
```

That's it~

Configuration is saved in `config.yaml` by default, and data like resumable download information
is saved in `data.json`. Playwright uses a headed browser for login, so the current version may
require a GUI system. Of course, you can also copy the cookies from a GUI system after logging in.

Downloaded files are placed in the `downloads` directory, organized as
`userDisplayName(@username)` + `videos`/`photos` + `title-date(YYYYMMDD_HHmmss)-#FDpostId(-index).ext`.

## Q&A

1. Crashing because of node-av?

> You can manually download the pre-built binary from the node-av repository releases and place
it at `node_modules/node-av/binary/node-av.node`
