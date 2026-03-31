## Deployment Process

### Prerequisites

Before you begin, ensure you have the following:

- **AWS CLI**: Installed and configured with appropriate access to your AWS account.
- **AWS CDK**: Installed globally (`npm install -g aws-cdk`) or available via `npx`.
- **Node.js**: Version 22.x+.
- **Git**
- **pnpm**: Version 9.1.4 or later.

---

### Setup

**Clone the repository**

```bash
git clone https://github.com/truemark/autoalarm.git
cd autoalarm
```

**Install dependencies**

```bash
pnpm install
```

**Configure AWS credentials**

```bash
export AWS_REGION=<region>
export AWS_ACCESS_KEY_ID="<access-key-id>"
export AWS_SECRET_ACCESS_KEY="<secret-access-key>"
export AWS_SESSION_TOKEN="<aws-session-token>"   # if using temporary credentials
```

**Bootstrap CDK** (one-time per account/region)

```bash
cd cdk && npx cdk bootstrap
```

**Build the project**

```bash
cd .. && pnpm build
```

---

### Deployment Options

#### Option 1: Basic (alarm management only)

Deploys AutoAlarm to a single account. Alarms are created/managed per-account as resources are tagged.

```bash
cd cdk && npx cdk deploy AutoAlarm
```

Optional: include a Prometheus workspace ID to enable metric publishing to Amazon Managed Prometheus:

```bash
cd cdk && npx cdk deploy AutoAlarm \
  -c prometheusWorkspaceId='ws-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'
```

#### Option 2: Hub account with enrichment pipeline

Deploys the centralized enrichment pipeline. This account receives alarm events from source accounts, enriches them with context (metrics, logs, deployments), and publishes to an SNS topic.

**Step 1: Find your AWS Organization ID**

```bash
aws organizations describe-organization --query 'Organization.Id' --output text
# Output: o-xxxxxxxxxx
```

**Step 2: Deploy to the hub account**

```bash
cd cdk && npx cdk deploy AutoAlarm \
  -c EnableOamSink=true \
  -c OamOrganizationIds='o-xxxxxxxxxx' \
  -c EnableEnrichment=true \
  -c EnrichmentOrganizationIds='o-xxxxxxxxxx'
```

Replace `o-xxxxxxxxxx` with your Organization ID from Step 1.

To scope access to specific accounts instead of an entire org, use account IDs:

```bash
cd cdk && npx cdk deploy AutoAlarm \
  -c EnableOamSink=true \
  -c OamSourceAccountIds='111122223333,444455556666' \
  -c EnableEnrichment=true \
  -c EnrichmentSourceAccountIds='111122223333,444455556666'
```

#### Option 3: Hub account + StackSet for source accounts

Automatically deploys OAM Links and EventBridge forwarding rules to source accounts across your organization via CloudFormation StackSets.

**Step 1: Find your Organization ID and OU IDs**

```bash
# Organization ID
aws organizations describe-organization --query 'Organization.Id' --output text
# Output: o-xxxxxxxxxx

# Root ID (needed to list OUs)
ROOT_ID=$(aws organizations list-roots --query 'Roots[0].Id' --output text)

# List OUs under root
aws organizations list-organizational-units-for-parent \
  --parent-id $ROOT_ID \
  --query 'OrganizationalUnits[*].{Id:Id,Name:Name}' \
  --output table
# Output: ou-xxxx-xxxxxxxx (e.g. ou-ab12-cdefghij)
```

**Step 2: Register the hub account as a delegated StackSets administrator** (skip if deploying from the org management account)

```bash
aws organizations register-delegated-administrator \
  --account-id <HUB_ACCOUNT_ID> \
  --service-principal stacksets.cloudformation.amazonaws.com
```

**Step 3: Deploy**

```bash
cd cdk && npx cdk deploy AutoAlarm \
  -c EnableOamSink=true \
  -c OamOrganizationIds='o-xxxxxxxxxx' \
  -c EnableEnrichment=true \
  -c EnrichmentOrganizationIds='o-xxxxxxxxxx' \
  -c EnableSourceAccountStackSet=true \
  -c StackSetTargetOuIds='ou-xxxx-xxxxxxxx' \
  -c StackSetDeploymentRegions='us-east-1,us-west-2'
```

Multiple OUs can be comma-separated: `StackSetTargetOuIds='ou-xxxx-aaaaaaaa,ou-xxxx-bbbbbbbb'`

#### Option 4: Hub account with AI enrichment (Bedrock AgentCore)

Adds AI-generated incident summaries for Critical alarms. Requires a deployed AgentCore runtime (separate setup).

```bash
cd cdk && npx cdk deploy AutoAlarm \
  -c EnableEnrichment=true \
  -c EnrichmentOrganizationIds='o-xxxxxxxxxx' \
  -c EnableAgentEnrichment=true \
  -c AgentRuntimeArn='arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/abc123' \
  -c AgentSeverityFilter='Critical'
```

---

### All Context Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `prometheusWorkspaceId` | Amazon Managed Prometheus workspace ID | — |
| `EnableReAlarm` | Enable the ReAlarm (re-trigger) feature | `true` |
| `EnableOamSink` | Create an OAM Sink for cross-account metric/log sharing | `false` |
| `OamOrganizationIds` | Comma-separated org IDs allowed to link to the OAM sink | — |
| `OamSourceAccountIds` | Comma-separated account IDs allowed to link (alternative to org IDs) | — |
| `EnableEnrichment` | Deploy the enrichment pipeline (EventBridge bus, Lambda, SNS) | `false` |
| `EnrichmentOrganizationIds` | Comma-separated org IDs allowed to forward events to the hub bus | — |
| `EnrichmentSourceAccountIds` | Comma-separated account IDs (alternative to org IDs) | — |
| `EnableAgentEnrichment` | Enable Bedrock AgentCore for AI incident summaries | `false` |
| `AgentRuntimeArn` | ARN of the AgentCore runtime to invoke | — |
| `AgentSeverityFilter` | Comma-separated severities that trigger agent invocation | `Critical` |
| `EnableSourceAccountStackSet` | Deploy OAM Link + EventBridge rule to source accounts via StackSet | `false` |
| `StackSetTargetOuIds` | Comma-separated OU IDs to deploy the StackSet to | — |
| `StackSetDeploymentRegions` | Comma-separated regions for StackSet deployment | Hub region |
| `StackSetLogGroupFilter` | Log group name filter for OAM Link (e.g. `/ecs/*,/aws/lambda/*`) | All groups |
| `StackSetPermissionModel` | `SERVICE_MANAGED` or `SELF_MANAGED` | `SERVICE_MANAGED` |

---

### Tear Down

```bash
cd cdk && npx cdk destroy AutoAlarm
```

Note: if you deployed a StackSet, delete it first from the CloudFormation console or the StackSet will block stack deletion.
