# The ALB belongs to the upstream guidance stack, so it is read here rather
# than declared. Re-declaring it would either create a second load balancer or
# require importing a resource another stack owns - both worse than reading it.
#
# The idle timeout itself is set by infra/bootstrap.sh via the CLI, because it
# is a one-attribute change to someone else's resource. That is exactly the
# "use the guidance for the bulk and the CLI only for what it does not cover"
# split the talk argues for.
#
# The timeout is a matched pair with general_settings.keepalive_timeout in
# config/config.yaml, and LiteLLM is explicit that KEEPALIVE_TIMEOUT must sit
# ABOVE the load balancer idle timeout or streams are cut mid-flight:
#
#   ALB idle timeout      120s   (var.alb_idle_timeout_seconds)
#   LiteLLM KEEPALIVE     130s   (config/config.yaml)
#
# The same timeout governs the dashboard's SSE connection. Verify both.

data "aws_lb" "gateway" {
  arn = var.alb_arn
}
