# CodeQL Remediation Orchestrator

A GitHub Action that automatically identifies and fixes CodeQL security vulnerabilities using Devin AI, with intelligent batching, parallel execution, real-time dashboard, and a learning feedback loop.

## Features

### Intelligent Batching Engine
- **Triage by Severity**: Critical issues are processed first, then high, medium, and low
- **Batch by Vulnerability Type**: Groups similar CWE types together for more effective fixes
- **Configurable Strategies**: Choose from multiple batching approaches or use the default
- **Smart Scheduling**: Accumulates alerts to avoid processing batch sizes of 1

### Parallel Devin Sessions
- Run multiple Devin sessions simultaneously for faster remediation
- Configurable parallelism (default: 3 concurrent sessions)
- Automatic coordination to avoid conflicts between batches

### Multi-Signal Confidence Scoring
Unlike simple LLM self-assessment, our confidence scoring uses multiple objective signals:
- **CodeQL Re-validation (40%)**: Verifies the vulnerability is actually fixed
- **Test Coverage (20%)**: Checks if existing tests pass after the fix
- **Change Scope (20%)**: Smaller, focused changes score higher
- **Historical Pattern (20%)**: Learns from past fix success rates

### Learning Feedback Loop
- Records outcomes of every fix attempt (merged, rejected, reverted)
- Performs RCA on failed fixes and stores learnings
- Improves confidence predictions over time based on historical data
- Tracks success rates by CWE type

### Real-Time Dashboard
- Live progress tracking with auto-refresh
- Before/after security posture visualization
- Interactive controls (pause, resume, rebatch)
- Links to all Devin sessions and PRs
- Learning insights and statistics

### Rich PR Descriptions
- CWE/CVE references with links
- Before/after code snippets
- Confidence score with detailed explanation
- Test suggestions from Devin
- Full transparency with session links

## Quick Start

### 1. Add the Action to Your Workflow

Create `.github/workflows/codeql-remediation.yml`:

```yaml
name: CodeQL Remediation

on:
  workflow_run:
    workflows: ["CodeQL"]
    types:
      - completed
  schedule:
    - cron: '0 0 * * 0'  # Weekly on Sunday
  workflow_dispatch:  # Manual trigger

jobs:
  remediate:
    runs-on: ubuntu-latest
    if: ${{ github.event.workflow_run.conclusion == 'success' || github.event_name != 'workflow_run' }}
    
    steps:
      - name: Run CodeQL Remediation
        uses: your-org/codeql-remediation-orchestrator@v1
        with:
          devin_api_key: ${{ secrets.DEVIN_API_KEY }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
          batching_strategy: 'severity-then-cwe'
          max_batch_size: 5
          max_parallel_sessions: 3
          min_confidence_threshold: 0.7
          severity_filter: 'critical,high,medium'
```

### 2. Configure Secrets

Add the following secrets to your repository:
- `DEVIN_API_KEY`: Your Devin API key from [Devin Settings](https://app.devin.ai/settings)

### 3. Enable GitHub Pages (Optional)

To use the real-time dashboard:
1. Go to Settings > Pages
2. Set Source to "Deploy from a branch"
3. Select the `gh-pages` branch

## Configuration Options

| Input | Description | Default |
|-------|-------------|---------|
| `devin_api_key` | Devin API key (required) | - |
| `github_token` | GitHub token with `security_events` scope (required) | - |
| `batching_strategy` | Batching strategy to use | `severity-then-cwe` |
| `max_batch_size` | Maximum alerts per batch | `5` |
| `max_parallel_sessions` | Maximum concurrent Devin sessions | `3` |
| `min_confidence_threshold` | Minimum confidence for auto-approval | `0.7` |
| `severity_filter` | Comma-separated severities to process | `critical,high,medium` |
| `min_alerts_threshold` | Minimum alerts before processing | `3` |
| `dashboard_branch` | Branch for dashboard deployment | `gh-pages` |
| `dry_run` | Analyze without creating sessions | `false` |

### Batching Strategies

| Strategy | Description |
|----------|-------------|
| `severity-then-cwe` | Triage by severity, then group by CWE type (recommended) |
| `severity-only` | Group only by severity level |
| `by-file` | Group by file/directory |
| `by-cwe` | Group only by CWE type |
| `by-complexity` | Group by estimated fix complexity |

## Outputs

| Output | Description |
|--------|-------------|
| `session_count` | Number of Devin sessions created |
| `pr_count` | Number of PRs created |
| `alerts_processed` | Number of alerts processed |
| `dashboard_url` | URL to the remediation dashboard |
| `run_id` | Unique identifier for this run |

## Dashboard

The dashboard provides real-time visibility into the remediation process:

### Security Posture
- Before/after comparison of vulnerability counts
- Breakdown by severity level
- Visual progress indicators

### Batch Progress
- Status of each batch (pending, in progress, completed, failed)
- Links to Devin sessions
- Links to created PRs
- Confidence scores

### Learning Insights
- Overall fix success rate
- Top vulnerability types
- Historical trends

### Interactive Controls
The dashboard supports interactive controls via the control state file:
- **Pause/Resume**: Temporarily halt processing
- **Rebatch**: Request re-batching with a different strategy
- **Skip Batch**: Skip specific batches
- **Priority Override**: Change batch priorities

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    GitHub Actions Workflow                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │    Alert     │───▶│   Batching   │───▶│    Devin     │      │
│  │   Fetcher    │    │    Engine    │    │ Orchestrator │      │
│  └──────────────┘    └──────────────┘    └──────────────┘      │
│         │                   │                    │               │
│         ▼                   ▼                    ▼               │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │  Confidence  │◀───│   Learning   │◀───│     PR       │      │
│  │    Scorer    │    │    Store     │    │  Generator   │      │
│  └──────────────┘    └──────────────┘    └──────────────┘      │
│         │                   │                    │               │
│         └───────────────────┼────────────────────┘               │
│                             ▼                                    │
│                    ┌──────────────┐                             │
│                    │  Dashboard   │                             │
│                    │  Publisher   │                             │
│                    └──────────────┘                             │
│                             │                                    │
└─────────────────────────────┼────────────────────────────────────┘
                              ▼
                    ┌──────────────┐
                    │ GitHub Pages │
                    │  Dashboard   │
                    └──────────────┘
```

## Confidence Scoring

Our multi-signal confidence scoring provides more accurate predictions than LLM self-assessment:

### Signal Weights
- **CodeQL Validation (40%)**: Re-runs CodeQL on the PR to verify the fix
- **Test Coverage (20%)**: Checks if CI tests pass
- **Change Scope (20%)**: Evaluates the size and focus of changes
- **Historical Pattern (20%)**: Uses past success rates for similar fixes

### Thresholds
- **≥ 0.9**: High confidence - safe for auto-merge (if enabled)
- **0.7 - 0.9**: Moderate confidence - standard review
- **< 0.7**: Low confidence - flagged for careful review

## Learning System

The orchestrator maintains a learning store that improves over time:

### What's Tracked
- Fix outcomes (merged, rejected, reverted)
- Confidence scores vs actual results
- Failure reasons and RCA
- Success rates by CWE type

### How It's Used
- Adjusts confidence predictions based on historical data
- Warns about patterns that have failed before
- Suggests alternative approaches for problematic CWEs

### Storage
Learning data is stored in `.codeql-remediation/learning-data.json` in your repository.

## Example PR Description

```markdown
## Summary

This PR addresses **3** CodeQL security alerts related to **CWE-79** with **high** severity.

### Vulnerability Type

Cross-site Scripting (XSS) - Improper neutralization of input during web page generation...

## Alerts Fixed

| # | Alert | File | Lines | Severity |
|---|-------|------|-------|----------|
| [#42](link) | Reflected XSS | `src/api/handler.js` | L15-20 | high |
| [#43](link) | Stored XSS | `src/views/comment.js` | L88 | high |
| [#44](link) | DOM XSS | `src/client/render.js` | L102-105 | high |

## Confidence Assessment

**Overall Confidence:** 🟢 **85%**

CodeQL validation passed. All tests passing. Changes are minimal and focused.

### Signal Breakdown

| Signal | Score | Weight |
|--------|-------|--------|
| CodeQL Validation | 🟢 95% | 40% |
| Test Coverage | 🟢 90% | 20% |
| Change Scope | 🟢 85% | 20% |
| Historical Pattern | 🟡 70% | 20% |

## Security References

- [CWE-79](https://cwe.mitre.org/data/definitions/79.html)

## Metadata

- **Batch ID:** `abc123`
- **Strategy:** severity-then-cwe
- **Devin Session:** [View Session](https://app.devin.ai/sessions/...)
```

## Contributing

Contributions are welcome! Please read our contributing guidelines before submitting PRs.

## License

MIT License - see [LICENSE](LICENSE) for details.

## Support

For questions or issues:
- Open a GitHub issue
- Email: support@example.com
