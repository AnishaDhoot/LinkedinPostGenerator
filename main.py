import json
import os
import traceback
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import List, Optional

# Import the LangGraph compiled application
from project import app as agent_app

app = FastAPI(
    title="LinkedIn Post Generator API",
    description="Backend API wrapper for the iterative LinkedIn Post Generator agent.",
    version="1.0.0"
)

# Enable CORS for Next.js frontend development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class GenerateRequest(BaseModel):
    topic: str

@app.get("/api/health")
def health_check():
    """Health check endpoint to verify backend status."""
    return {
        "status": "healthy"
    }

@app.post("/api/generate")
async def generate_post(request: GenerateRequest):
    """Runs the LangGraph agent and streams execution steps back to the client."""
    topic = request.topic.strip()
    if not topic:
        raise HTTPException(status_code=400, detail="Topic cannot be empty.")

    def event_generator():
        initial_state = {
            "topic": topic,
            "messages": [],
            "draft": "",
            "review_feedback": "",
            "is_approved": False,
            "attempt": 0,
        }

        try:
            # Stream graph updates in real-time
            for chunk in agent_app.stream(initial_state, stream_mode="updates"):
                # Clean up chunk data to make it JSON-serializable if it contains messages
                serializable_chunk = {}
                for node_name, updates in chunk.items():
                    serializable_updates = {}
                    for key, val in updates.items():
                        if key == "messages":
                            # Convert LangChain messages to simple dicts
                            msg_list = []
                            for m in val:
                                msg_type = "human"
                                content = ""
                                
                                # Handle both message objects and tuples
                                if isinstance(m, tuple):
                                    # If it's a tuple, extract content from the second element
                                    if len(m) > 1:
                                        content = str(m[1]) if m[1] else ""
                                else:
                                    # Handle message objects
                                    if hasattr(m, "type"):
                                        msg_type = m.type
                                    if hasattr(m, "content"):
                                        content = m.content
                                    
                                    # Convert tool calls list to dicts
                                    tool_calls = []
                                    if getattr(m, "tool_calls", None):
                                        for tc in m.tool_calls:
                                            tool_calls.append({
                                                "name": tc.get("name"),
                                                "args": tc.get("args"),
                                                "id": tc.get("id")
                                            })
                                    
                                    msg_list.append({
                                        "role": msg_type,
                                        "content": content,
                                        "tool_calls": tool_calls if tool_calls else None
                                    })
                                    continue
                                
                                # For tuples, create a simple message dict
                                msg_list.append({
                                    "role": msg_type,
                                    "content": content,
                                    "tool_calls": None
                                })
                            serializable_updates[key] = msg_list
                        else:
                            serializable_updates[key] = val
                    serializable_chunk[node_name] = serializable_updates

                yield f"data: {json.dumps(serializable_chunk)}\n\n"
            
            # Send a completion event
            yield f"data: {json.dumps({'status': 'completed'})}\n\n"

        except Exception as e:
            tb = traceback.format_exc()
            print("Error in generation stream:", tb)
            yield f"data: {json.dumps({'status': 'error', 'message': str(e)})}\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")

if __name__ == "__main__":
    import uvicorn
    # Run FastAPI server on port 8000
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)
