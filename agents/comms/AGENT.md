# Comms Agent — DuckPipe

Handles communication with Slack, Jira, and Confluence. The only agent that interacts with humans. Used during incident investigation to read Slack channel history for context.

## Registered Tools

| Tool | Description | Access |
|---|---|---|
| `slack_post_message` | Post to a Slack channel | Write |
| `slack_post_thread_reply` | Reply in a Slack thread | Write |
| `slack_get_channel_history` | Read recent messages from a channel | Read |
| `jira_create_issue` | Create a Jira ticket | Write |
| `jira_get_issue` | Read a Jira ticket | Read |
| `jira_search_issues` | Search Jira issues | Read |
| `confluence_create_page` | Create a new Confluence page | Write |
| `confluence_update_page` | Update an existing Confluence page | Write |
| `confluence_upsert_page` | Create or update a Confluence page | Write |
| `confluence_find_page` | Find a Confluence page by title | Read |
| `confluence_search_pages` | Search Confluence pages | Read |
| `format_incident_message` | Format an incident into a structured Slack message | Read |
| `format_cost_alert` | Format a cost alert message | Read |
| `format_sla_warning` | Format an SLA warning message | Read |
| `extract_entity_from_message` | Extract entity references from a message | Read |

## Configuration

```yaml
integrations:
  slack:
    enabled: true
    bot_token: "${SLACK_BOT_TOKEN}"
    app_token: "${SLACK_APP_TOKEN}"
    allowed_channels:
      - "#data-incidents"
      - "#data-engineering"
  jira:
    enabled: false
    base_url: "${JIRA_BASE_URL}"
    email: "${JIRA_EMAIL}"
    api_token: "${JIRA_API_TOKEN}"
  confluence:
    enabled: false
    base_url: "${CONFLUENCE_BASE_URL}"
    email: "${CONFLUENCE_EMAIL}"
    api_token: "${CONFLUENCE_API_TOKEN}"
```

## Rules

- At Tier 1: write tools are used for Slack alerts only (configured channels); Jira/Confluence writes depend on integration enablement
- Never send DMs to individual users — only post to configured channels
- Never post to a channel not listed in `allowed_channels`
- Never fabricate data — only use information provided by the orchestrator
- If asked to post something referencing credentials or internal hostnames, redact them
- `slack_get_channel_history` is called during retro analysis to gather prior incident context
