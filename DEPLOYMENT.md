## Deployment Process

### Prerequisites

#### **Before you begin, ensure you have the following:**
- **AWS CLI**: Installed and configured with appropriate access to your AWS account.
- **AWS CDK**
- **Node.js**: Version 22.x+.
- **Git**
- **pnpm**: Version 9.1.4 or later.


#### **To set up and deploy the AutoAlarm project, follow these steps:**
- **Clone the Repository**

Start by cloning the project repository to your local machine:

  ```bash
  git clone https://github.com/truemark/autoalarm.git
  cd autoalarm
  ```

- **Install Dependencies**

  ```bash
  pnpm install
  ```

- **Configure Region**

  ```bash
  export AWS_REGION=<region>
  ```

- **Configure Keys and Session Token**

  ```bash
  export AWS_ACCESS_KEY_ID="<access-key-id"
  export AWS_SECRET_ACCESS_KEY="<secret-access-key>"
  export AWS_SESSION_TOKEN="<aws-session-token>"
  ```

- **Bootstrap the CDK**

  ```bash
  cdk bootstrap
  ```

- **Build the Project**

    ```bash
    pnpm build
    ```

- **Deploy the Stack**

    ```bash
    cd cdk ; cdk deploy AutoAlarm
    ```
