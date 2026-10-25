# Battalion

**Auto Router, but for all your agent accounts.**

Battalion is a personal, local-first agent mesh for one owner. You already have several coding agents and assistants, each with its own login, tools, and limits, and today you are the one copying context between them. Battalion puts a captain in charge: your orchestrator sends a task to the right crew member, or to several at once, and shows you where they agree and where they disagree. Every hand-off goes through a local broker. Scopes decide what an agent can see before it runs, risky steps wait for your approval, secrets are redacted, and each decision is written to a hash-chained audit log you can verify. It runs on your own machine for one person. It is not a team cloud product.

## Status

Early prototype, not yet released. There is no code in this repository yet. The prototype is being built and tested privately, and it will land here once it passes real-agent tests.

## How it works (planned)

- **Crew:** each agent account you connect (coding CLIs, app assistants, local models) gets a card with its name, role, and status.
- **Captain:** the orchestrator you choose. On each task, one agent leads as the **flagship**, so two orchestrators never steer the same task.
- **Voyage:** a task, with a scope that says which files and folders it may touch.
- **Stamps:** the broker's decisions. APPROVED, DENIED, or HELD FOR REVIEW, with the reason logged.
- **Logbook:** the audit log. Dated, hash-chained entries, checked with one command.
- **Disagreement:** when you ask several agents, the result is a comparison, not a blend. You see the split and decide.

## Theme

Battalion's look and voice borrow from anime pirate and navy adventure: wanted-poster crew cards, nautical charts, logbooks, and approval stamps. The design is original and uses only generic pirate and navy vocabulary. It is not affiliated with, or endorsed by, any show, studio, or publisher.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
