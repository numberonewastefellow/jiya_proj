@echo off
echo --- Logging initial event from Mumbai ---
curl.exe -X POST http://localhost:5002/api/fraud/log-event -H "Content-Type: application/json" -d "{\"userId\": \"660f6b4d3269894e68e7d9b1\", \"eventType\": \"login\", \"ipAddress\": \"::1\"}"
echo.
echo --- Evaluating transaction from New York ---
curl.exe -X POST http://localhost:5002/api/fraud/evaluate-transaction -H "Content-Type: application/json" -d "{\"userId\": \"660f6b4d3269894e68e7d9b1\", \"ipAddress\": \"161.185.160.93\", \"transactionDetails\": {\"items\": [{\"name\": \"Test Product\", \"quantity\": 1}], \"totalAmount\": 100}}"
echo.
