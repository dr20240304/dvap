# Steps 3-5: who is calling, what may they do, what does the human see
1. The supplier portal gets its own token. What can that token do? Compare `tools/list` for two different identities.
2. Where does the MCP server decide who the caller is? Is there anything besides the bearer token it looks at?
3. Which tool changes the rules the other tools are checked against? Who is allowed to call it? Then read the approval screen: where does its headline text come from?

## V29
The approve button is just a POST. What stops a page you did not open, or another process, from sending the same request without your session?

## More Approve bugs (V9, V12, V23, V26, V27, V30)
- V9: after some normal use, read the server's log. What is in it?
- V12: send two payments in one batch call so that together they exceed the daily cap.
- V26: the override says "up to $1,000". Try $1,200.
- V23: a tool takes a regular expression. Give it one that backtracks.
- V27: make a request with `Host: evil.example`. Who answers?
- V30: ask the remittance tool to fetch a URL you control. What headers arrive?
