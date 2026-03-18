# dbt Agent — DuckPipe

Monitors dbt Cloud jobs and models. Reads manifest for lineage, detects recent changes, and identifies affected models during incident investigation.

## Registered Tools

| Tool | Description | Access |
|---|---|---|
| `list_jobs` | List all dbt jobs in the project | Read |
| `get_run` | Get details of a specific run including errors | Read |
| `get_manifest` | Fetch the compiled dbt manifest.json (lineage graph) | Read |
| `list_models` | List all models with their current status | Read |
| `find_affected_models` | Find models affected by a source table change | Read |
| `check_recent_changes` | Check for recent dbt model or source changes | Read |
| `get_project_graph` | Get the full project dependency graph | Read |
| `load_local_manifest` | Load a local manifest file for lineage analysis | Read |
| `create_branch` | Create a new feature branch on GitHub | Write (blocked at Tier 1) |
| `push_file` | Push a modified file to a branch | Write (blocked at Tier 1) |
| `create_pr` | Open a pull request with description | Write (blocked at Tier 1) |

## Configuration

```yaml
integrations:
  dbt:
    enabled: true
    cloud_url: "https://cloud.getdbt.com"
    api_token: "${DBT_API_TOKEN}"
    account_id: "${DBT_ACCOUNT_ID}"
    project_id: "${DBT_PROJECT_ID}"
```

## Rules

- At Tier 1: all write tools (`create_branch`, `push_file`, `create_pr`) are blocked by the policy engine
- Read tools are used during incident investigation to trace dbt lineage and identify affected models
- `check_recent_changes` is called during retro analysis to correlate model changes with failures
