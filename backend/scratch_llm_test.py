import asyncio
import time
import httpx
import json

OLLAMA_HOST = "https://api.sharedllm.com/ollama"
OLLAMA_MODEL = "claude-3-haiku-20240307"
SHAREDLLM_KEY = "sk-sharedllm-Q29PNlAlOzr5pl7i7JZ7h_Jqxsd9r8gy92lY8hTTAL8"

async def test_llm():
    url = f"{OLLAMA_HOST}/api/chat"
    payload = {
        "model": OLLAMA_MODEL,
        "messages": [{"role": "user", "content": "Explain quantum computing in one short sentence."}],
        "stream": True,
    }
    
    headers = {"Content-Type": "application/json", "X-SharedLLM-Key": SHAREDLLM_KEY}
    
    print(f"Testing {OLLAMA_MODEL} latency...")
    start_time = time.time()
    
    async with httpx.AsyncClient(timeout=120.0) as client:
        try:
            async with client.stream("POST", url, json=payload, headers=headers) as response:
                response.raise_for_status()
                
                first_token_time = None
                
                async for line in response.aiter_lines():
                    if not line: continue
                    if first_token_time is None:
                        first_token_time = time.time()
                        print(f"TTFT (Time To First Token): {first_token_time - start_time:.2f}s")
                    
                    data = json.loads(line)
                    chunk = data.get("message", {}).get("content", "")
                    print(chunk, end="", flush=True)
                
                end_time = time.time()
                print(f"\n\nTotal Generation Time: {end_time - start_time:.2f}s")
        except Exception as e:
            print(f"Error: {e}")

if __name__ == "__main__":
    asyncio.run(test_llm())
