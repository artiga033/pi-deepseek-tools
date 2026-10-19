# pi-deepseek-tools

Provider-agnostic `web_search` and `web_fetch` tools for [pi](https://pi.dev), backed by DeepSeek's Search & Fetch APIs.

The tools are independent of the chat model: use them with DeepSeek, Anthropic, OpenAI, or any local model. Credentials and usage statistics live in their own user-level file, separate from pi's provider configuration.

## Features

- `web_search` — live web search with titles, URLs, summaries, dates, authority and relevance scores.
- `web_fetch` — fetch a page and return its main content as Markdown.
- Works with any chat model; no provider switching required.
- Credentials can be entered directly, inherited from a configured model, or resolved automatically.
- Per-tool switches, call statistics, and a status view through `/deepseek_tools`.
- Search/fetch results are truncated to keep model context under control.

## Install

From a git tag (recommended for releases):

```bash
pi install git:github.com/<you>/pi-deepseek-tools@v0.1.0
```

From a branch, when you want to follow development:

```bash
pi install git:github.com/<you>/pi-deepseek-tools@main
```

From a local checkout:

```bash
pi install ./pi-deepseek-tools
```

Try it for a single invocation without installing:

```bash
pi -e ./pi-deepseek-tools
```

Git tags and commits are pinned when installed. To move to a newer release, install the new tag explicitly, or use a branch ref if you prefer to track development.

## Credentials

Run:

```
/deepseek_tools login
```

You can choose to:

1. enter a DeepSeek API key;
2. inherit credentials from a model that pi already has credentials for (only the `provider/model` reference is stored; the key is resolved at request time, so rotation and refreshes keep working);
3. use automatic resolution: pi's `deepseek` login first, then `DEEPSEEK_API_KEY`;
4. clear the saved configuration.

Automatic resolution order:

1. `auth.mode: "key"` → the key stored in the config file;
2. `auth.mode: "model"` → credentials of the selected model, resolved through pi's model runtime;
3. `auth.mode: "auto"` → the active `deepseek` model, any registered `deepseek` model, then `DEEPSEEK_API_KEY`.

The tools never read or copy `auth.json` themselves; everything goes through pi's `ModelRegistry`.

## Commands

```
/deepseek_tools            # interactive menu
/deepseek_tools login      # configure credentials
/deepseek_tools logout     # clear saved credentials
/deepseek_tools tools      # toggle web_search / web_fetch
/deepseek_tools stats      # call statistics
/deepseek_tools status     # credential source and tool switches
```

`tools` changes take effect immediately and are restored on the next session start.

## Configuration file

```
~/.pi/agent/deepseek-tools.json
```

The path follows `PI_CODING_AGENT_DIR` when set.

```json
{
  "version": 1,
  "auth": {
    "mode": "auto"
  },
  "tools": {
    "web_search": true,
    "web_fetch": true
  },
  "stats": {
    "web_search": {
      "calls": 0,
      "succeeded": 0,
      "failed": 0,
      "totalResults": 0,
      "totalContentChars": 0,
      "totalLatencyMs": 0,
      "lastCallAt": null,
      "lastError": null
    },
    "web_fetch": {
      "calls": 0,
      "succeeded": 0,
      "failed": 0,
      "totalResults": 0,
      "totalContentChars": 0,
      "totalLatencyMs": 0,
      "lastCallAt": null,
      "lastError": null
    }
  }
}
```

Writes use a temporary file plus `rename`, and concurrent tool calls are serialized, so statistics are not lost.

## Tool parameters

### `web_search`

| Parameter | Type | Description |
|---|---|---|
| `query` | string | Search query, 1–128 characters |
| `count` | number | Number of results, 1–50 (default 10) |
| `need_content` | boolean | Include page body text in each result (default false) |
| `ori_question` | string | Original user question, helps intent understanding |
| `localization` | string | IP address used to prefer localized results |

Supports operators such as `site:`, `-site:`, `"exact phrase"`, `lang:zh,en`, `after:2025-01-01`, and `before:2026`.

### `web_fetch`

| Parameter | Type | Description |
|---|---|---|
| `url` | string | Absolute http(s) URL, max 8192 characters |

## Billing

DeepSeek Search and Fetch are billed per successful request by DeepSeek. Check the [official documentation](https://api-docs.deepseek.com/zh-cn/guides/search) for current pricing and rate limits. The `/deepseek_tools stats` output counts calls made by this extension, but it is not a billing statement.

## Notes

- `web_search` and `web_fetch` are generic names. If another extension or MCP server registers the same tool names, disable one of them with `/tools`.
- The extension only talks to `https://api.deepseek.com` by default; set `DEEPSEEK_BASE_URL` to override it.

## Development

The extension is plain TypeScript and needs no build step:

```bash
pi -e .                       # load this package
pi --no-session --print --tools web_search "search for pi coding agent"
```

## Release

This package is distributed through git; no npm publish step is required.

```bash
git init
git add -A
git commit -m "Initial release"
git tag v0.1.0
git remote add origin git@github.com:<you>/pi-deepseek-tools.git
git push -u origin main --tags
```

For a later release, bump `version` in `package.json`, commit, and push a new tag (for example `v0.1.1`). Consumers install the new tag explicitly.

## License

Public Domain (Unlicense). See [LICENSE](./LICENSE).
