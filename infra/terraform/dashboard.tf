# The dashboard data plane, as a second ECS service behind the same ALB.
#
# The guidance deploys the gateway only. This is the FastAPI service the
# browser opens the SSE stream against - deliberately NOT routed through the
# Next.js app on Amplify, because Amplify Hosting lists Next.js streaming as
# unsupported.

resource "aws_cloudwatch_log_group" "dashboard" {
  name              = "/ecs/${var.project}-dashboard"
  retention_in_days = 7
  tags              = { Project = var.project }
}

resource "aws_ecs_task_definition" "dashboard" {
  family                   = "${var.project}-dashboard"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.dashboard_execution.arn

  container_definitions = jsonencode([{
    name         = "dashboard"
    image        = var.dashboard_image
    essential    = true
    portMappings = [{ containerPort = 8080, protocol = "tcp" }]
    environment = [
      # Pin the exact Amplify origin. Never "*": this endpoint is reachable
      # from the internet through the ALB.
      { name = "DASHBOARD_CORS_ORIGIN", value = var.dashboard_cors_origin },
      { name = "ROUTER_STATE_PATH", value = "/app/router_state/posteriors.json" },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.dashboard.name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "ecs"
      }
    }
    healthCheck = {
      command     = ["CMD-SHELL", "python -c \"import urllib.request;urllib.request.urlopen('http://localhost:8080/health')\" || exit 1"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 20
    }
  }])

  tags = { Project = var.project }
}

resource "aws_ecs_service" "dashboard" {
  name            = "${var.project}-dashboard"
  cluster         = var.ecs_cluster_arn
  task_definition = aws_ecs_task_definition.dashboard.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [var.ecs_security_group_id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.dashboard.arn
    container_name   = "dashboard"
    container_port   = 8080
  }

  tags = { Project = var.project }
}

resource "aws_lb_target_group" "dashboard" {
  name        = "${var.project}-dash-tg"
  port        = 8080
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip"

  health_check {
    path                = "/health"
    interval            = 30
    healthy_threshold   = 2
    unhealthy_threshold = 3
    matcher             = "200"
  }

  # SSE connections are long-lived. The default 300s deregistration delay would
  # cut a viewer's stream on every deployment; 30s is enough to drain and short
  # enough not to stall a redeploy mid-talk.
  deregistration_delay = 30

  tags = { Project = var.project }
}

resource "aws_lb_listener_rule" "dashboard" {
  listener_arn = var.alb_listener_arn
  priority     = 100

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.dashboard.arn
  }

  condition {
    path_pattern {
      values = ["/state", "/spend", "/stream", "/shadow", "/health"]
    }
  }
}

resource "aws_iam_role" "dashboard_execution" {
  name = "${var.project}-dashboard-execution"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = { Project = var.project }
}

resource "aws_iam_role_policy_attachment" "dashboard_execution" {
  role       = aws_iam_role.dashboard_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}
