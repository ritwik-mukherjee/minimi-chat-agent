# minimi chat agent

A chat agent with web search and dated memory. See [DESIGN.md](DESIGN.md) for how it works and why.

## Run it

Needs Node 26.13.0 or newer.

```bash
nvm use
npm install
cp .env.example .env
```

Put your Anthropic API key in `.env` as `ANTHROPIC_API_KEY`. The key's organisation must have web search enabled in the Claude Console. Then:

```bash
npm run dev
```

Open http://localhost:3000.

Optional settings in `.env`: `MODEL_DEFAULT` and `MODEL_COMPARE` (both `claude-sonnet-5-5`), `PORT` (3000) and `DB_PATH` (`data/turns.db`). Saved turns live in `data/`, which git ignores. "Clear saved turns" in the page deletes them.

## See memory work in one sitting

1.  Ask "What does Neon's free tier include?"
2.  Ask "What did I ask you earlier today? Is it still correct?" The saved question appears first, then the agent re-checks it against today's sources.
3.  Click "Saved turns" to see both turns with their sources.

Dated phrases such as "last Tuesday" or "3 November" work the same way once something is saved for that day. Asking about a day with nothing saved gets a plain "nothing saved" reply.

## Tests

```bash
npm run typecheck
npm test
```

Tests run offline and never call the API.

```bash
npm run measure
```

`npm run measure` uses your key and a temporary database to time real turns.
