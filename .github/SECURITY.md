# Security policy

## Supported versions

This repository is an incomplete alpha scaffold. The checked-in code is not a production analytics service.

## Reporting a vulnerability

Please report suspected vulnerabilities privately through
[GitHub's private vulnerability reporting](https://github.com/NexaStellar/lumina-analytics/security/advisories/new).
Do not include exploit details, credentials, or personal data in a public issue.

Reports should include the affected commit or release, impact, and concise reproduction steps. The maintainers will acknowledge reports and coordinate disclosure after a fix is available.

## Safe handling

Never commit secrets or production credentials. Validate and bound all untrusted network and API input before exposing future endpoints. Do not use the development credentials in Compose for production.
