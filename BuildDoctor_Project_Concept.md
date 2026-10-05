# 🩺 BuildDoctor

> **If you can build it, BuildDoctor can help you ship it.**

**BuildDoctor** is an AI-powered DevOps agent designed to bridge the gap between **application development and cloud deployment**.

A developer can build an application successfully, but getting that application from a GitHub repository to a **verified, working AWS deployment** often requires a completely different set of DevOps skills.

BuildDoctor aims to make that journey dramatically simpler.

---

## 1. 🎯 The Problem

Many developers can build:

- React / Next.js applications
- Node.js / Express APIs
- Python / FastAPI applications
- Django applications
- Go services
- Database-backed applications

But deployment introduces another layer of complexity:

```mermaid
flowchart LR
    DEV["👨‍💻 Developer"] --> CODE["Application works locally"]
    CODE --> D1["Docker"]
    D1 --> D2["AWS"]
    D2 --> D3["Networking"]
    D3 --> D4["Security Groups"]
    D4 --> D5["Environment Variables"]
    D5 --> D6["Cloud Logs"]
    D6 --> D7["Health Checks"]
    D7 --> LIVE["🚀 Live Application"]
```

The developer suddenly needs to understand Docker, Linux, cloud infrastructure, networking, registries, deployment configuration, logs, and troubleshooting.

### The core problem

> **Building an application and deploying an application are two different skill sets.**

BuildDoctor exists to bridge that gap.

---

# 2. 💡 The Core Idea

The user provides a GitHub repository and the required deployment configuration.

BuildDoctor handles the deployment journey.

```mermaid
flowchart LR
    REPO["🔗 GitHub Repository"] --> BD["🩺 BuildDoctor"]
    BD --> UNDERSTAND["🔍 Understand Project"]
    UNDERSTAND --> CONTAINER["🐳 Prepare / Validate Docker"]
    CONTAINER --> BUILD["📦 Build & Verify"]
    BUILD --> AWS["☁️ Deploy to AWS"]
    AWS --> HEALTH["❤️ Health Check"]
    HEALTH --> LIVE["🚀 Live Application"]
```

The ideal experience is:

```text
GitHub Repository
       ↓
   BuildDoctor
       ↓
Understand the Project
       ↓
Validate / Prepare Docker Setup
       ↓
Build & Verify
       ↓
Deploy to AWS
       ↓
Health Check
       ↓
    🚀 LIVE
```

If something fails:

```mermaid
flowchart TD
    DEPLOY["☁️ Deployment"] --> CHECK["❤️ Health Check"]
    CHECK -->|Healthy| LIVE["🚀 LIVE"]
    CHECK -->|Failed| LOGS["📋 Collect Logs / Errors"]
    LOGS --> AI["🤖 AI Diagnosis"]
    AI --> FIX["🔧 Suggest / Apply Fix"]
    FIX --> BUILD["📦 Rebuild"]
    BUILD --> REDEPLOY["🚀 Redeploy"]
    REDEPLOY --> CHECK
```

---

# 3. 🩺 What Exactly Is BuildDoctor?

BuildDoctor is **not just an AI Dockerfile generator**.

It is **not just a CI/CD log analyzer**.

It is **not just an AWS deployment script**.

It combines these capabilities into one deployment-oriented agent.

### BuildDoctor's job

> **Understand the application → prepare it for deployment → deploy it → verify it → diagnose failures → recover when possible.**

---

# 4. 👤 What Does the User Provide?

At the beginning, BuildDoctor collects the information required to safely perform the deployment.

## Repository

- GitHub repository URL
- Branch to deploy
- GitHub authentication/access if the repository is private

### Repository access

```mermaid
flowchart TD
    INPUT["GitHub Repository"] --> TYPE{"Repository Type?"}
    TYPE -->|Public| PUBLIC["Analyze directly"]
    TYPE -->|Private| AUTH["Request GitHub authorization"]
    AUTH --> ACCESS["Authorized repository access"]
    PUBLIC --> SCAN["Repository Scan"]
    ACCESS --> SCAN
```

A public repository can be analyzed directly.

A private repository requires appropriate authorization.

---

# 5. ☁️ AWS / Deployment Configuration

The user can provide or select:

- AWS account/profile
- AWS region
- Deployment target
- Existing EC2 instance **or** permission to create one
- Existing Security Group **or** permission to create one
- Instance type preference
- Application/network port
- Environment variables / secrets where required

The important principle is:

> **The AI should understand the deployment, but the user should remain in control of important infrastructure decisions.**

---

# 6. 🔍 Repository Understanding

Before changing or deploying anything, BuildDoctor should understand what it is dealing with.

```mermaid
flowchart TD
    REPO["GitHub Repository"] --> SCAN["Repository Scan"]

    SCAN --> STACK["Technology / Framework"]
    SCAN --> DEPS["Dependency Files"]
    SCAN --> ENTRY["Entry Point / Start Command"]
    SCAN --> PORT["Application Port"]
    SCAN --> ENV["Environment Variables"]
    SCAN --> DOCKER{"Existing Dockerfile?"}

    STACK --> CONTEXT["🧠 Project Context"]
    DEPS --> CONTEXT
    ENTRY --> CONTEXT
    PORT --> CONTEXT
    ENV --> CONTEXT
    DOCKER --> CONTEXT
```

### Examples

**Technology / Framework**

```text
Node.js
Express
Next.js
React
Python
FastAPI
Django
Go
```

**Dependency files**

```text
package.json
requirements.txt
pyproject.toml
go.mod
```

**Entry points**

```text
npm start
python app.py
uvicorn main:app
gunicorn app:app
```

**Ports**

```text
3000
5000
8000
8080
```

BuildDoctor should identify these as part of the project's deployment context.

---

# 7. 🐳 Existing Dockerfile Intelligence

One of the most important rules:

> **BuildDoctor should not blindly overwrite an existing Dockerfile.**

First, it checks whether the repository already has Docker configuration.

```mermaid
flowchart TD
    REPO["Repository"] --> DOCKER{"Dockerfile exists?"}

    DOCKER -->|No| GENERATE["🤖 Generate Dockerfile"]
    DOCKER -->|Yes| ANALYZE["🔍 Analyze Existing Dockerfile"]

    ANALYZE --> VALID{"Is it valid?"}

    VALID -->|Yes| USE["✅ Use Existing Dockerfile"]
    VALID -->|No| FIX["🩺 Explain / Fix Dockerfile"]
    VALID -->|Works but can improve| OPT["⚡ Recommend Optimization"]

    GENERATE --> BUILD["📦 Build"]
    USE --> BUILD
    FIX --> BUILD
    OPT --> BUILD
```

## Case 1 — No Dockerfile

```text
Repository
    ↓
No Dockerfile
    ↓
Understand project
    ↓
Generate Dockerfile
```

## Case 2 — Dockerfile is valid

```text
✓ Dependencies make sense
✓ Start command is correct
✓ Port configuration matches
✓ Image builds successfully

→ Use existing Dockerfile
```

## Case 3 — Dockerfile is broken

```text
❌ Wrong dependency
❌ Wrong start command
❌ Wrong port

→ Explain the problem
→ Suggest / apply correction
→ Build again
```

## Case 4 — Dockerfile works but is inefficient

```text
✓ Application works

⚠ Image is unnecessarily large
⚠ Development dependencies included
⚠ Build layers could be optimized

→ Recommend improvements
```

Initially, optimization should be presented as a recommendation rather than silently replacing the user's working setup.

---

# 8. 📦 Build Validation

Before deployment, BuildDoctor should verify that the application can actually be built and started.

```mermaid
flowchart LR
    DOCKER["Docker Configuration"] --> BUILD["🐳 Build Image"]
    BUILD --> RUN["▶️ Run Container"]
    RUN --> START{"Application Starts?"}
    START -->|Yes| HEALTH["❤️ Startup / Health Check"]
    START -->|No| ERROR["❌ Build / Runtime Error"]
    ERROR --> AI["🤖 AI Diagnosis"]
    AI --> FIX["🔧 Fix / Recommend"]
    FIX --> BUILD
    HEALTH --> READY["✅ Ready for Deployment"]
```

A successful Docker build alone is not enough.

BuildDoctor should verify that the application actually starts and responds as expected.

---

# 9. ☁️ AWS Deployment

Once the application is ready, BuildDoctor handles the cloud deployment workflow.

The initial deployment target can be kept simple:

```mermaid
flowchart LR
    IMAGE["🐳 Docker Image"] --> ECR["Amazon ECR"]
    ECR --> EC2["Amazon EC2"]
    EC2 --> CONTAINER["Running Container"]
    CONTAINER --> APP["🌐 Application"]
```

BuildDoctor may work with:

- Existing EC2 instances
- Newly created EC2 instances
- Existing Security Groups
- Newly created Security Groups
- ECR repositories

The developer should not need to manually perform every AWS console step.

---

# 10. 🚀 End-to-End Deployment Journey

This is the central BuildDoctor workflow.

```mermaid
flowchart TD
    USER["👨‍💻 User"] --> REPO["🔗 GitHub Repository"]
    REPO --> CONFIG["☁️ AWS / Deployment Configuration"]

    CONFIG --> SCAN["🔍 Analyze Repository"]

    SCAN --> DOCKER{"Docker Setup"}
    DOCKER -->|Existing| VALIDATE["Validate Existing Dockerfile"]
    DOCKER -->|Missing| GENERATE["Generate Dockerfile"]

    VALIDATE --> BUILD["📦 Build & Run"]
    GENERATE --> BUILD

    BUILD --> RESULT{"Build / Startup OK?"}

    RESULT -->|No| DIAGNOSE["🩺 Diagnose"]
    DIAGNOSE --> FIX["🔧 Fix / Retry"]
    FIX --> BUILD

    RESULT -->|Yes| ECR["📦 Push to ECR"]
    ECR --> AWS["☁️ Deploy to EC2"]
    AWS --> HEALTH["❤️ Health Check"]

    HEALTH --> STATUS{"Application Healthy?"}

    STATUS -->|Yes| LIVE["🚀 APPLICATION LIVE"]
    STATUS -->|No| CLOUDLOGS["📋 Collect Cloud / Container Logs"]
    CLOUDLOGS --> DIAGNOSE
```

---

# 11. ❤️ Deployment Verification

Deployment is not considered successful merely because the container started.

BuildDoctor should verify:

```mermaid
flowchart TD
    DEPLOY["Container Deployed"] --> RUNNING{"Container Running?"}
    RUNNING -->|No| LOGS["Collect Logs"]
    RUNNING -->|Yes| RESPONSE{"Application Responding?"}
    RESPONSE -->|No| LOGS
    RESPONSE -->|Yes| HEALTH{"Health Check Passed?"}
    HEALTH -->|No| LOGS
    HEALTH -->|Yes| SUCCESS["🚀 Deployment Successful"]
```

A successful deployment could result in:

```text
🚀 Deployment Successful

Application:
https://example.com

Status:
Healthy

BuildDoctor verified:

✓ Container running
✓ Application responding
✓ Health check passed
```

---

# 12. 🧠 AI Failure Diagnosis

This is where BuildDoctor becomes more than a deployment automation tool.

Deployment failures can happen because of:

- Wrong port
- Missing dependency
- Incorrect start command
- Missing environment variable
- Dockerfile error
- Application crash
- Permission problem
- Container exits immediately
- Security Group configuration
- Insufficient resources
- Application starts but cannot be reached

Instead of:

```text
Deployment Failed
```

BuildDoctor should investigate.

---

# 13. 🩹 The BuildDoctor Feedback Loop

The central agentic behavior can be represented as:

```mermaid
flowchart LR
    OBSERVE["👀 Observe"] --> UNDERSTAND["🧠 Understand"]
    UNDERSTAND --> DIAGNOSE["🩺 Diagnose"]
    DIAGNOSE --> ACT["🔧 Act"]
    ACT --> VERIFY["❤️ Verify"]
    VERIFY -->|Success| DONE["🚀 Done"]
    VERIFY -->|Failure| OBSERVE
```

### Example

```text
Deployment
    ↓
❌ Health Check Failed
    ↓
Collect logs
    ↓
Analyze application state
    ↓
Identify root cause
    ↓
Apply / suggest fix
    ↓
Rebuild
    ↓
Redeploy
    ↓
Health Check
```

If successful:

```text
✓ Application recovered
```

If not:

```text
BuildDoctor explains:

Root Cause:
...

Evidence:
...

Attempted Fix:
...

Result:
...

Recommended Next Step:
...
```

---

# 14. 🧪 Example Scenario

Imagine a developer has a Node.js application.

They provide:

```text
GitHub:
github.com/user/my-app
```

BuildDoctor analyzes it:

```text
Project Analysis
────────────────────────

Framework: Express
Runtime: Node.js
Entry Point: server.js
Port: 3000

Dockerfile:
Found existing Dockerfile

Dockerfile Status:
Valid

Deployment Target:
AWS EC2
```

The application is built and deployed.

But the application fails to start.

The logs contain:

```text
Error: Cannot find module 'express'
```

BuildDoctor reasons:

```text
Root Cause:
express is imported by the application but is missing
from the production dependencies.

Evidence:
Application imports express.
Package dependencies do not contain the required package.
```

It proposes a fix.

After the fix:

```text
✓ Build successful
✓ Image created
✓ Image deployed
✓ Container running
✓ Health check passed

🚀 Your application is live.
```

---

# 15. 🛡️ Safety and User Control

BuildDoctor should not blindly make destructive cloud changes.

Important infrastructure operations should have approval gates when appropriate.

For example:

```mermaid
flowchart TD
    AGENT["🤖 BuildDoctor"] --> PLAN["Deployment Plan"]
    PLAN --> APPROVAL{"User Approval?"}
    APPROVAL -->|Yes| ACTION["☁️ Execute Action"]
    APPROVAL -->|No| STOP["⏸️ Stop / Modify Plan"]
    ACTION --> VERIFY["❤️ Verify"]
```

Example:

```text
BuildDoctor wants to:

Create a new EC2 instance
Create a Security Group
Create an ECR repository

Proceed?

[Y/n]
```

Destructive actions such as terminating infrastructure should require explicit confirmation.

---

# 16. 🖥️ Ideal User Experience

The goal is to hide unnecessary DevOps complexity.

```mermaid
sequenceDiagram
    actor User
    participant BD as BuildDoctor
    participant GitHub
    participant AWS

    User->>BD: GitHub repository + deployment configuration
    BD->>GitHub: Analyze repository
    GitHub-->>BD: Project context

    BD->>BD: Validate / generate Docker setup
    BD->>BD: Build & verify

    BD->>AWS: Prepare deployment
    AWS-->>BD: Infrastructure ready

    BD->>AWS: Deploy application
    AWS-->>BD: Deployment status

    BD->>AWS: Health check
    AWS-->>BD: Healthy

    BD-->>User: 🚀 Application is live
```

The user should feel like:

> **"I gave it my project, and it took care of deployment."**

---

# 17. 🧩 BuildDoctor Capabilities

BuildDoctor can be thought of as four major capabilities:

```mermaid
mindmap
  root((🩺 BuildDoctor))
    🔍 Understand
      Repository scanning
      Tech stack detection
      Entry point
      Port
      Environment requirements
    🐳 Prepare
      Existing Dockerfile validation
      Dockerfile generation
      Docker build
      Runtime verification
    ☁️ Deploy
      AWS configuration
      ECR
      EC2
      Security Groups
      Application deployment
    🩺 Heal
      Logs
      Failure diagnosis
      Fix suggestions
      Retry
      Health verification
```

---

# 18. 🔥 Why This Is Different

## Not just an AI Dockerfile Generator

Because BuildDoctor also:

```text
Understand
   ↓
Build
   ↓
Deploy
   ↓
Verify
```

## Not just a CI/CD Log Analyzer

Because it starts from the application repository and handles the deployment journey.

## Not just an AWS deployment script

Because it understands the application and can reason about failures.

### The larger idea

> **BuildDoctor is the bridge between application development and application deployment.**

---

# 19. 🚧 MVP Scope

The first version should remain focused.

### MVP supports

- GitHub repositories
- Public repositories first
- Node.js applications
- Python applications
- Existing Dockerfile detection
- Dockerfile generation when missing
- Docker build validation
- AWS ECR
- AWS EC2
- Basic Security Group configuration
- Application health checks
- Deployment logs
- AI failure diagnosis
- Basic fix/retry loop

### MVP goal

> **GitHub repository → verified application running on AWS**

```mermaid
flowchart LR
    GH["GitHub Repo"] --> SCAN["Scan"]
    SCAN --> DOCKER["Docker"]
    DOCKER --> BUILD["Build"]
    BUILD --> ECR["ECR"]
    ECR --> EC2["EC2"]
    EC2 --> HEALTH["Health Check"]
    HEALTH --> LIVE["🚀 LIVE"]
```

---

# 20. 🔮 Future Expansion

Once the core workflow is stable, BuildDoctor can expand.

## More languages and frameworks

```text
Go
Java
Django
FastAPI
Next.js
Spring Boot
```

## More deployment targets

```text
ECS
EKS
Kubernetes
Serverless containers
```

## More intelligent remediation

```mermaid
flowchart TD
    FAIL["Deployment Failure"] --> ROOT["Root Cause Analysis"]
    ROOT --> PATCH["Generate Fix"]
    PATCH --> TEST["Test Fix"]
    TEST -->|Pass| DEPLOY["Deploy"]
    TEST -->|Fail| REASON["Re-evaluate"]
    REASON --> PATCH
    DEPLOY --> VERIFY["Verify"]
```

## CI/CD integration

The original AI CI/CD Log Analyzer idea can become another BuildDoctor capability:

```mermaid
flowchart LR
    PUSH["Git Push"] --> CI["GitHub Actions"]
    CI --> RESULT{"Pipeline"}
    RESULT -->|Pass| DONE["✅"]
    RESULT -->|Fail| LOGS["📋 Logs"]
    LOGS --> BD["🩺 BuildDoctor"]
    BD --> RCA["Root Cause"]
    RCA --> COMMENT["💬 PR Comment"]
```

This means BuildDoctor can eventually help both **before deployment** and **after deployment**.

---

# 21. 🌐 Long-Term Vision

The long-term vision is not:

> "AI that writes Dockerfiles."

It is:

> **An AI DevOps agent that takes an application from source code to a verified cloud deployment.**

The developer should not need to be an expert in:

- Docker
- Linux deployment
- AWS
- Networking
- Container registries
- Deployment configuration
- Cloud troubleshooting

BuildDoctor handles the operational complexity while keeping the developer informed and in control.

---

# 22. 🏷️ One-Line Product Definition

> **BuildDoctor is an AI-powered DevOps agent that takes a GitHub repository, understands the application, prepares and validates its container setup, deploys it to AWS, verifies that it is live, and diagnoses or fixes deployment failures.**

---

# 23. ❤️ The Core Philosophy

```mermaid
flowchart TD
    DEV["👨‍💻 Developer"] --> BUILD["Build Application"]
    BUILD --> GITHUB["🔗 GitHub Repository"]
    GITHUB --> BD["🩺 BuildDoctor"]

    BD --> UNDERSTAND["Understand"]
    UNDERSTAND --> PREPARE["Prepare"]
    PREPARE --> DEPLOY["Deploy"]
    DEPLOY --> VERIFY["Verify"]

    VERIFY -->|Healthy| LIVE["🚀 LIVE"]
    VERIFY -->|Failed| HEAL["🩹 Diagnose & Fix"]
    HEAL --> DEPLOY
```

### Developers build the application.

### BuildDoctor gets it deployed.

> **If you can build it, BuildDoctor can help you ship it.**
