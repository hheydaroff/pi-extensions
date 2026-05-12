# pi-extensions

Pi coding agent extensions — managed here, deployed to `~/.pi/agent/extensions/` via `deploy.sh`.

## Usage

```bash
# Deploy after edits
bash deploy.sh
```

## Structure

- Single-file extensions: `*.ts`
- Multi-file extensions: directories with `index.ts` + `package.json`
