# RFC-002 — Implementation Blueprint for AI-Assisted SDD & Kanban Automation

**Status:** Draft  
**Version:** 1.0  
**Date:** 23/06/2026  
**Authors:** Architecture & Platform Engineering  
**Related RFC:** RFC-001 (Processo de Gestão de Produto, Desenvolvimento e Entrega Assistido por IA)

---

## 1. Objective

This RFC serves as the **implementation blueprint** for enhancing the AI-Assisted Spec-Driven Development (SDD) process defined in RFC-001. 

Based on the architectural review and gap analysis of RFC-001, this document provides prescriptive, actionable specifications for an automated agent (GitHub Action + LLM integration) to execute the workflow. It defines:

- Standardized templates for `spec.md` and `plan.md`.
- The exact payload structure for LLM API calls.
- A concrete strategy for generating and maintaining the `tech_context`.
- Automation rules for GitHub Projects.
- Validation gates, metrics, and risk mitigations.

---

## 2. Guiding Principles

In addition to RFC-001's principles, the following implementation-specific principles apply:

- **Determinism over Creativity:** LLM parameters (e.g., `temperature`) must be configured for maximum consistency.
- **Human-in-the-loop:** AI generates and suggests; Humans validate and approve. No artifact moves to production without explicit human sign-off (RACI matrix).
- **Traceability:** Every technical decision in `plan.md` must reference a specific requirement in `spec.md`.
- **Declarative Configuration:** The system's technical context must be version-controlled (Infrastructure as Code) to ensure repeatability.

---

## 3. Standardized Artifact Templates

### 3.1. `spec.md` Structure

The LLM must generate `spec.md` following this exact markdown schema. The agent will parse this schema to validate completeness.

```markdown
# Specification: {{feature_title}}

## 1. Overview
- **Objective:** [Clear statement of what this achieves]
- **User Personas:** [List of affected users]
- **Success Criteria:** [Measurable outcomes]

## 2. Business Rules
- [Rule 1]: Description
- [Rule 2]: Description

## 3. Flows
### 3.1. Happy Path
[Step-by-step description]

### 3.2. Alternative Flows
[Variations of the happy path]

### 3.3. Error Scenarios
[Handling of failures/edge cases]

## 4. Acceptance Criteria (Gherkin)
```gherkin
Feature: [Feature Name]
  Scenario: [Scenario Title]
    Given [Precondition]
    When [Action]
    Then [Expected Result]
```

## 5. Dependencies
- **Internal:** [Services/APIs within the system]
- **External:** [Third-party systems]

## 6. Non-Functional Requirements
- **Performance:** [e.g., Response time < 200ms]
- **Security:** [e.g., RBAC required]
- **Usability:** [e.g., Mobile-responsive]
```

### 3.2. `plan.md` Structure

The `plan.md` must directly trace back to the `spec.md` sections.

```markdown
# Technical Plan: {{feature_title}}

## 1. Technical Strategy
- **Architectural Approach:** [e.g., CQRS, Event Sourcing]
- **Key Design Decisions:** [Justification for chosen technologies/patterns]
- **Traceability Matrix:** [Mapping each Acceptance Criterion to a technical component]

## 2. Implementation Breakdown
### 2.1. Backend
- **API Changes:** [Endpoints, DTOs, Controllers]
- **Business Logic:** [Services, Use Cases]
- **Background Jobs:** [Queues, Workers]

### 2.2. Database
- **New Tables:** [Schema definitions]
- **Migrations:** [Alterations to existing tables]
- **Indexes:** [Performance optimizations]

### 2.3. Frontend
- **UI Components:** [New screens or widgets]
- **State Management:** [Store changes, API clients]
- **Routing:** [New routes, guards]

### 2.4. Infrastructure
- **ConfigMaps/Secrets:** [Kubernetes changes]
- **Pipeline Updates:** [CI/CD modifications]
- **Feature Flags:** [Rollout strategy]

## 3. Security & Compliance
- **Authentication/Authorization:** [Which roles can access?]
- **Data Encryption:** [At rest / in transit]
- **Logging & Auditing:** [What needs to be logged?]

## 4. Testing Strategy
- **Unit Tests:** [Scope and frameworks]
- **Integration Tests:** [Scope and mocks]
- **E2E Tests:** [Critical paths]

## 5. Rollback & Monitoring
- **Rollback Plan:** [Database rollbacks, code reverts]
- **Observed Metrics:** [New Relic/Datadog dashboards]
- **Alerts:** [Thresholds and escalation paths]
```

---

## 4. Tech Context Management

To ensure the LLM generates contextually accurate plans, the agent must read a single source of truth for the system's current state.

### 4.1. Static Source of Truth
The agent must look for `.github/config/tech_context.yml` in the repository root. If missing, the agent must scaffold it.

```yaml
# .github/config/tech_context.yml
system_info:
  name: "Order Management System"
  stack:
    backend: "Node.js (NestJS v10)"
    frontend: "React 18 with Vite"
    database: "PostgreSQL 15"
    cache: "Redis 7"
    messaging: "RabbitMQ"
    infra: "Kubernetes (EKS) + Helm"
  architecture: "Microservices via API Gateway"

security:
  auth_protocol: "JWT (Access/Refresh)"
  rbac_roles: ["ADMIN", "MANAGER", "GARCOM", "COZINHA"]

database_schemas:
  - table: "users"
    columns: "id, name, email, role, password_hash"
  - table: "tables"
    columns: "id, number, status, capacity"
  - table: "products"
    columns: "id, name, category, price, stock"

existing_services:
  - name: "Inventory API"
    endpoint: "/api/inventory/{productId}/availability"
    auth: "mTLS"
    docs: "https://docs.internal/inventory"

internal_libraries:
  - "shared-logger"
  - "db-client (TypeORM)"
```

### 4.2. Dynamic Augmentation
The agent must augment the static YAML with dynamic, ephemeral context:
- **Recent Migrations:** Parse the latest migration files (e.g., `ls -la migrations/*.sql`).
- **Package Versions:** Read `package.json` or `pom.xml` to confirm exact library versions (e.g., `@nestjs/core: ^10.2.0`).

### 4.3. Override Mechanism
If the GitHub Issue body contains a markdown section exactly titled `## Tech Override`, the agent must parse and deep-merge this override over the static config. This allows temporary deviations (e.g., "Use DynamoDB for this specific feature").

---

## 5. LLM Integration & Payload Design

The agent must execute two sequential LLM calls. All calls must use `response_format: { type: "json_object" }` and a `temperature` of `0.2` to ensure deterministic outputs.

### 5.1. Call 1: Generating `spec.md`

**Input Payload (Agent to LLM):**
```json
{
  "metadata": {
    "feature_title": "{{issue.title}}",
    "feature_description": "{{issue.body_summary}}",
    "epic_context": "{{project.custom_field.Epic}}",
    "priority": "{{project.custom_field.Priority}}",
    "labels": ["{{issue.labels}}"]
  },
  "business_input": {
    "user_personas": "Extracted from issue body (e.g., Garçom, Cozinha)",
    "business_rules_raw": "Extracted from issue body checklist",
    "acceptance_criteria_raw": "Extracted from issue body checklist",
    "constraints": "Extracted from issue body comments"
  }
}
```

**System Prompt (Static):**
```text
You are a Product Management expert. Generate a spec.md strictly following the provided markdown template. Do not invent business rules. If information is missing, explicitly mark it as "[TODO: Requires PO clarification]".
```

### 5.2. Call 2: Generating `plan.md`

**Input Payload (Agent to LLM):**
```json
{
  "spec_content": "{{OUTPUT_FROM_CALL_1}}",
  "tech_context": {
    "static": "{{READ_FROM_.github/config/tech_context.yml}}",
    "dynamic": {
      "recent_migrations": "{{ls_migrations_output}}",
      "current_packages": "{{package.json_dependencies}}"
    },
    "overrides": "{{PARSED_FROM_ISSUE_BODY}}"
  }
}
```

**System Prompt (Static):**
```text
You are a Senior Tech Lead. Generate a technical plan (plan.md) strictly based on the provided spec.md. 
- EVERY database change, API endpoint, or UI component MUST trace back to a specific Acceptance Criterion in the spec.
- Use ONLY the technologies listed in the tech_context.
- Provide actionable implementation details (e.g., exact endpoint paths, DTO names, database constraints).
```

---

## 6. GitHub Project Configuration (Automation)

The agent must configure the GitHub Project with specific fields and automate transitions.

### 6.1. Custom Fields
| Field Name | Type | Options | Required |
|------------|------|---------|----------|
| Work Item Type | Single select | Epic, Feature, Story, Task, Bug, Spike, RFC | Yes |
| Priority | Single select | P0, P1, P2, P3 | Yes |
| Story Points | Number | 1, 2, 3, 5, 8, 13 | For Stories |
| Area | Single select | Frontend, Backend, Mobile, Infra, Data | Yes |
| AI Confidence Score | Number | 0-100 | Auto-filled by agent |

### 6.2. Automation Rules (Agent Triggers)
The agent must enforce these rules via GitHub Actions:
- **Rule 1:** Feature moved to `Ready` → Trigger `spec.md` and `plan.md` generation. 
- **Rule 2:** PR opened linking a Story → Move Story from `Development` to `Code Review`.
- **Rule 3:** PR merged → Move Story to `QA`.
- **Rule 4:** Story marked `Done` → Check if all child Tasks are `Done`; otherwise, block transition.

---

## 7. RACI Matrix (Implementation of Governance)

The agent must enforce these permissions via bot comments and checklists.

| Activity | PO | Tech Lead | Developer | QA | DevOps | **Agent** |
|----------|----|-----------|-----------|----|--------|-----------|
| Generate `spec.md` | I | I | I | I | I | **R/A** |
| Approve `spec.md` | **R/A** | C | I | I | I | I |
| Generate `plan.md` | I | I | I | I | I | **R/A** |
| Approve `plan.md` | I | **R/A** | C | I | I | I |
| Validate Decomposition | I | **R/A** | C | I | I | I |
| Implement Code | I | C | **R/A** | I | I | I |
| Code Review | I | C | **R/A** | I | I | I |
| Test | I | I | C | **R/A** | I | I |
| Deploy | I | C | C | I | **R/A** | I |

**Legend:** R=Responsible (executes), A=Accountable (signs off), C=Consulted, I=Informed.

---

## 8. Enhanced Decomposition Rules (Stories/Tasks)

When the agent decomposes a Feature into Stories and Tasks (as per RFC-001, Section 8), it must respect these boundaries:

### 8.1. Story Decomposition
- Each Story must map to exactly **one User Persona** (e.g., "Garçom" cannot be mixed with "Cozinha").
- Each Story must be **independently testable** (i.e., can be validated via a single Gherkin scenario).
- Maximum **5 Stories per Feature**. Exceeding this triggers a warning to the Tech Lead to split the Feature.

### 8.2. Task Decomposition
- Each Task must be **< 4 hours** of work.
- Tasks must have a **clear dependency graph** (e.g., DB Migration → Entity → Service → Controller → UI).
- The agent automatically links dependencies using GitHub's "Blocked By" field.

---

## 9. Quality Gates & Testing Strategy

The agent must enforce these gates before moving a Story to `Done`:

| Gate # | Gate Name | Criteria | Action if Failed |
|--------|-----------|----------|-------------------|
| 1 | Unit Coverage | > 80% | Agent comments on PR |
| 2 | Integration Coverage | > 70% | Agent comments on PR |
| 3 | E2E Regression | All critical paths pass | Block merge to main |
| 4 | No P0/P1 Bugs | 0 critical bugs | Block deploy |

---

## 10. Metrics Implementation

The agent must collect and expose these metrics in the GitHub Project's Insights tab or via a scheduled issue report.

| Metric | Definition | Collection Method | Target Baseline |
|--------|------------|-------------------|-----------------|
| Lead Time | Ready → Done | Project timestamps | < 14 days |
| Cycle Time | Development → Done | Project timestamps | < 7 days |
| AI Decomposition Success Rate | Features requiring no manual Story/Task edits | Developer survey/agent diff | > 80% within 3 months |
| Pull Request Size | Lines of code per PR | GitHub API | < 400 LOC |
| Flow Efficiency | Active work time / Total time | Project timestamps | > 70% |

---

## 11. Risk Management

| Risk | Probability | Impact | Mitigation Strategy (Agent) |
|------|-------------|--------|-----------------------------|
| LLM hallucinates APIs that don't exist | Medium | High | Agent validates generated `plan.md` against the `existing_services` list in `tech_context.yml`. If mismatch, it flags a warning. |
| LLM generates massive Story/Task list | Low | Medium | Agent enforces 5-Story and 4-hour Task limits; auto-splits if exceeded. |
| `tech_context.yml` becomes outdated | High | Medium | Agent runs weekly cron job to check for new migration files and diff them against the static config, opening a PR to update it. |
| API Rate Limits exceeded | Low | High | Agent implements exponential backoff and queuing (via GitHub Actions concurrency groups). |

---

## 12. Communication & Reporting (Agent Automation)

The agent must create a **Weekly Summary Issue** every Monday at 9:00 AM using a scheduled GitHub Action.

**Weekly Summary Template:**
```markdown
# Weekly Delivery Report ({{date}})

## Metrics
- **Lead Time:** {{avg}} days (Goal: <14)
- **Throughput:** {{count}} Stories completed.

## Blockers
- [List any item stuck > 2 days in any column].

## AI Performance
- **Decomposition Success Rate:** {{percent}}%.
- **Spec/Plan Regeneration Requests:** {{count}}.

## Risk Alerts
- {{List any alert triggered}}
```

---

## 13. Implementation Roadmap (For the Agent/Dev Team)

The implementation of this RFC must follow a phased rollout:

| Phase | Timeline | Scope | Success Criteria |
|-------|----------|-------|-------------------|
| **1. Foundation** | Week 1 | Create `.github/config/tech_context.yml`; Implement `spec.md` and `plan.md` generation via API. | Agent generates artifacts for a sandbox Feature. |
| **2. Integration** | Week 2 | Implement GitHub Project automation (Fields, Rules) and the Decomposition logic. | Agent creates Stories/Tasks from `plan.md` and adds them to the Project. |
| **3. Validation** | Week 3 | Add RACI validation gates (checklists on PRs) and Testing coverage enforcement. | Agent blocks PRs if coverage drops below threshold. |
| **4. Rollout & Metrics** | Week 4 | Enable Weekly Reports and Metrics dashboards. Pilot with 2 real Features. | Metrics are visible; PO approves pilot Features. |
| **5. Full Adoption** | Week 5+ | Train team, turn off manual task creation permissions, fully rely on agent. | 100% of Features follow the SDD flow. |

---

## 14. Appendix: GitHub Action Workflow Skeleton

Below is the logical structure for the agent's main Action (`generate-spec-and-plan.yml`).

```yaml
name: AI SDD Agent
on:
  issues:
    types: [labeled, moved]
  project_card:
    types: [moved]

jobs:
  generate-artifacts:
    if: github.event.project_card.column.name == 'Ready' && github.event.issue.type == 'Feature'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Load Tech Context
        id: context
        run: |
          # Merge static YAML with dynamic env vars
          echo "context=$(cat .github/config/tech_context.yml | yq -o=json)" >> $GITHUB_OUTPUT
          
      - name: Generate spec.md
        id: spec
        run: |
          # Call LLM API with payload structure from Section 5.1
          curl -X POST $LLM_ENDPOINT -H "Authorization: $API_KEY" -d "$PAYLOAD" > spec.json
          echo "spec_content=$(jq -r '.content' spec.json)" >> $GITHUB_OUTPUT
          
      - name: Create PR with spec.md
        uses: peter-evans/create-pull-request@v6
        with:
          commit-message: "feat(spec): AI generated spec.md for feature ${{ github.event.issue.number }}"
          branch: "ai/spec-${{ github.event.issue.number }}"
          body: "This PR contains the AI-generated spec.md and plan.md. Please review and approve."
          
      - name: Validate and Decompose (Post-Approval)
        # Triggered manually by labeling the PR as "approved"
        run: |
          # Parse approved files and generate Stories/Tasks
          echo "Decomposition triggered..."
```

---

## 15. Next Steps

1.  **Assign Ownership:** Designate a Platform Engineer to implement the `.github/actions/sdd-agent/` Docker container.
2.  **Create Baseline:** Run the `agent init` script to generate the initial `tech_context.yml` for your repository.
3.  **Dry Run:** Test the workflow with a non-critical Feature to validate LLM prompts and GitHub Project interactions.
4.  **Feedback Loop:** Implement a manual "Regenerate" button (via issue comment `/regenerate spec`) to correct AI outputs without running the whole workflow again.

---

This RFC closes the gaps identified in RFC-001, providing a concrete, automated, and scalable path to AI-assisted Spec-Driven Development. **All enhancements described here are mandatory for the implementing agent.**
