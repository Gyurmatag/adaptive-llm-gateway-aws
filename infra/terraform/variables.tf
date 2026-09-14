variable "project" {
  description = "Name prefix and cost-allocation tag for every resource."
  type        = string
  default     = "awsday-gateway"
}

variable "aws_region" {
  description = "Region for the gateway stack. Must have Bedrock model access enabled."
  type        = string
  default     = "eu-central-1"
}

variable "alb_idle_timeout_seconds" {
  description = <<-EOT
    ALB idle timeout. Applies identically to streaming completions and to the
    dashboard SSE connection. LiteLLM's KEEPALIVE_TIMEOUT must be set ABOVE
    this number or streams get cut mid-flight. The two are a matched pair:
    see general_settings.keepalive_timeout in config/config.yaml.
  EOT
  type        = number
  default     = 120
}

variable "monthly_budget_usd" {
  description = "Hard AWS Budgets cap for the demo account."
  type        = number
  default     = 150
}

variable "budget_alert_email" {
  description = "Where budget and billing alarms go."
  type        = string
}

variable "dashboard_image" {
  description = "ECR image URI for the dashboard data plane."
  type        = string
}

variable "dashboard_cors_origin" {
  description = "Exact Amplify origin allowed to open the SSE stream. Never '*'."
  type        = string
}

variable "vpc_id" {
  type        = string
  description = "VPC created by the upstream guidance stack."
}

variable "private_subnet_ids" {
  type        = list(string)
  description = "Private subnets from the upstream guidance stack."
}

variable "alb_arn" {
  type        = string
  description = "ALB created by the upstream guidance stack."
}

variable "alb_listener_arn" {
  type        = string
  description = "HTTPS listener on the upstream ALB."
}

variable "ecs_cluster_arn" {
  type        = string
  description = "ECS cluster created by the upstream guidance stack."
}

variable "ecs_security_group_id" {
  type        = string
  description = "Security group the gateway tasks run in."
}
