# Day-one cost control. The stack runs for days before the talk, so a cap and an
# alarm are not pre-flight items - they go up before anything else costs money.

resource "aws_budgets_budget" "demo" {
  name         = "${var.project}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  # Warn early, warn again, then warn on the forecast so the alert arrives
  # before the money is spent rather than after.
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 50
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.budget_alert_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.budget_alert_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.budget_alert_email]
  }
}

resource "aws_cloudwatch_metric_alarm" "billing" {
  alarm_name          = "${var.project}-billing"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "EstimatedCharges"
  namespace           = "AWS/Billing"
  period              = 21600
  statistic           = "Maximum"
  threshold           = var.monthly_budget_usd * 0.8
  alarm_description   = "Demo account estimated charges crossed 80% of the cap."
  dimensions          = { Currency = "USD" }
  treat_missing_data  = "notBreaching"
}
