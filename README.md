# Gr8r Studio

A calm, structured project management workspace: home dashboard, inbox, my tasks, projects with
board / list / table / calendar / timeline / files views, members, teams, activity and settings.

Built with plain JavaScript ES modules and CSS, bundled by [Vite](https://vite.dev). There is no
UI framework and no runtime dependency.

![Gr8r Studio home dashboard](docs/preview.png)

## Getting started

Requires Node.js 18 or newer (`.nvmrc` pins 22).

```bash
npm install
npm run dev       # http://localhost:5173 with hot reload
npm run build     # production build in dist/
npm run preview   # serve the production build locally
npm run lint      # ESLint
npm run format    # Prettier
```

## Project structure

```
index.html              HTML entry; loads src/main.js
public/favicon.svg      brand mark
vite.config.js          Vite config, including the Lucide icon-subset plugin
eslint.config.js        lint rules (ESLint flat config); formatting by Prettier (.prettierrc.json)
.github/workflows/      CI: lint, format check, build
docs/preview.png        README screenshot
src/
  main.js               entry: imports styles and modules, then boots the app
  styles/
    index.css           imports every stylesheet in cascade order
    tokens.css          colours, spacing, type, radius, the shared --gutter
    base.css  components.css  shell.css  panels.css  overlays.css  states.css  motion.css  responsive.css
    views/              list, board, table, calendar, timeline, projects & files
    pages/              settings, auth & onboarding
  core/                 utilities, constants, icons, store (state + lookups), theme
  data/seed.js          demo workspace data
  ui/                   shared render helpers, toasts, the select dropdown
  shell/                render loop and router, sidebar/topbar layout, skeletons, view engine
  components/           task list renderer
  pages/                one module per route
  views/                project views: board, table, calendar, timeline, files, overview
  overlays/             task drawer, modals, popovers, context menu, command palette
  features/             teams, subtasks, archive (rendering)
  actions/              user actions, event wiring, keyboard shortcuts, drag and drop
```

### Layers

Dependencies point downward:

1. `core/` and `data/` depend on nothing else in the app.
2. `ui/`, `shell/`, `components/`, `pages/`, `views/`, `overlays/` and `features/` render HTML from state.
3. `actions/` change state and re-render. Each action module registers its handlers on the
   shared action table (`A`) when it loads, so `main.js` imports them after `actions/actions.js`.

## Conventions

- **Rendering:** each page or view is a function that returns an HTML string from the store
  (`S`). `render()` rebuilds the shell and keeps focus and scroll positions.
- **Interactions:** elements declare `data-a="actionName"`. `actions/events.js` delegates the
  click to `A.actionName`. Inputs use `data-in`, blur handlers use `data-blur`.
- **Layout:** every page edge uses `var(--gutter)`, so the breadcrumb, page header, toolbar,
  list, table and board start on the same line.
- **Dropdowns:** write a normal `<select class="select">`. `ui/select.js` renders it as the
  design-system menu and keeps the native element as the source of truth.
- **Icons:** call `ic('name')` with any [Lucide](https://lucide.dev) icon name. The
  `virtual:icons` plugin bundles only the icons the source uses.

## Continuous integration

Every push and pull request runs lint, the format check and a production build
(`.github/workflows/ci.yml`).

## Deploy (Cloudflare Worker + D1, behind Access)

One Worker serves the built app (`dist/`), the sync API (`/api/*`) and the MCP server (`/mcp`) on
your own host. Data lives in D1; `migrations/` holds the schema.

1. `npx wrangler login`
2. `cp wrangler.example.jsonc wrangler.jsonc` (gitignored: it holds your host, database id and Access values, none of which belong in the repo).
3. `npx wrangler d1 create do`, then put the printed `database_id` in `wrangler.jsonc` along with your host.
4. In Zero Trust, add a **self-hosted application** for your host with two policies:
   _Allow_ your email (browser login) and _Service Auth_ (MCP clients). Copy its **AUD tag** and your
   team domain (`<team>.cloudflareaccess.com`) into `vars` in `wrangler.jsonc`.
5. Create a service token (Zero Trust > Access > Service auth) and keep the id and secret.
6. `npm run db:migrate && npm run deploy`

The Worker re-verifies the Access JWT on every request, and `workers.dev` / preview URLs are
disabled, so the only way in is through Access.

### Local development

```bash
cp .dev.vars.example .dev.vars   # DEV_BYPASS_ACCESS=1 skips Access locally only
npm run db:migrate:local
npm run worker:dev               # http://localhost:8787 (build + Worker + local D1)
```

## MCP (replaces Linear / Jira in every project)

Register once at user scope, so it is available in all projects:

```bash
claude mcp add --transport http --scope user do https://<your-host>/mcp \
  --header "CF-Access-Client-Id: <id>.access" --header "CF-Access-Client-Secret: <secret>"
```

Tools: `list_projects`, `get_project`, `save_project`, `list_issues`, `get_issue`, `save_issue`,
`list_comments`, `save_comment`, `delete_comment`, `list_issue_statuses`, `list_issue_labels`.
Issues are addressed by key (`WEB-204`); descriptions and comments are Markdown.
