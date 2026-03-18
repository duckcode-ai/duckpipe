# Airflow Agent — DuckPipe

Monitors Apache Airflow via its REST API. Detects DAG failures, reads task logs, and reports findings to the orchestrator.

## Registered Tools

| Tool | Description | Access |
|---|---|---|
| `check_failures` | Poll all DAGs for failed runs; returns status, affected DAGs, root cause, and evidence | Read |
| `list_dags` | List all DAGs and their current state | Read |
| `get_dag_runs` | Get recent runs for a specific DAG with status | Read |
| `get_running_dags` | List currently running DAGs | Read |
| `get_task_instances` | List task instances for a run with their state | Read |
| `get_task_logs` | Fetch logs for a specific task instance | Read |
| `trigger_dag_run` | Trigger a new DAG run | Write (blocked at Tier 1) |
| `clear_task` | Clear a failed task for retry | Write (blocked at Tier 1) |

## Output Contract (`check_failures`)

```json
{
  "status": "failure | warning | healthy",
  "affectedDags": ["string"],
  "rootCause": "string",
  "rootCauseCategory": "timeout | connection_error | logic_error | upstream_dependency | unknown",
  "evidence": ["string"],
  "recommendedAction": "string",
  "confidence": "high | medium | low"
}
```

## Configuration

```yaml
integrations:
  airflow:
    enabled: true
    base_url: "${AIRFLOW_BASE_URL}"        # Airflow webserver URL
    username: "${AIRFLOW_USERNAME}"         # Viewer role user
    password: "${AIRFLOW_PASSWORD}"
    allowed_dags: []                        # empty = all DAGs
```

## Rules

- At Tier 1: all write tools (`trigger_dag_run`, `clear_task`) are blocked by the policy engine
- Never access task logs for DAGs not in the `allowed_dags` config list
- If root cause cannot be determined with high confidence, report `confidence: low`
