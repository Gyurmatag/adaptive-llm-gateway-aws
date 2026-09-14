output "gateway_base_url" {
  description = "Set GATEWAY_BASE_URL to this. The single switch between the deployed stack and the local standby."
  value       = "https://${data.aws_lb.gateway.dns_name}"
}

output "dashboard_base_url" {
  description = "Data plane origin. This is what NEXT_PUBLIC_DATA_PLANE_URL must point at in Amplify - never localhost."
  value       = "https://${data.aws_lb.gateway.dns_name}"
}

output "alb_idle_timeout_seconds" {
  description = "Must stay BELOW general_settings.keepalive_timeout in config/config.yaml. Set by infra/bootstrap.sh."
  value       = var.alb_idle_timeout_seconds
}

output "budget_name" {
  value = aws_budgets_budget.demo.name
}
