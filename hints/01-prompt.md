# Steps 1-2: what the agent reads
1. Nobody reads the whole invoice memo. Print all of `INV-2002`, not just the first line. Invoices also arrive as PDFs through the AP mailbox (port 4400): what does its parser keep that a person reading the page would never see?
2. The agent trusts text from sources that are not its user. List every place it reads text from (invoice, tool descriptions, paid API responses). Which can an outsider write?
3. Look for a line starting `ASSISTANT_INSTRUCTION:`. Then ask: what did the *third-party* MCP server's tool description say last week versus today?

## More Prompt bugs (V11, V14)
- V11: who else can write to the memory the agent reads at the start of every run?
- V14: how does the agent decide which MCP servers to trust?
