#!/bin/bash

# Health check endpoint for VM orchestrator
# Used by Docker healthcheck to verify service is running

set -e

# Check if VM orchestrator is responding
response=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3003/health 2>/dev/null || echo "000")

if [ "$response" = "200" ]; then
    echo "VM orchestrator healthy"
    exit 0
else
    echo "VM orchestrator unhealthy (HTTP $response)"
    exit 1
fi
