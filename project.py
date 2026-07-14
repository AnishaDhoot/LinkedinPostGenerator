import os
from typing import TypedDict, Annotated, Literal
from langgraph.graph import StateGraph,START,END
from langgraph.graph.message import add_messages
from langgraph.prebuilt import ToolNode
from langchain_groq import ChatGroq
from langchain_tavily import TavilySearch
from dotenv import load_dotenv
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_core.messages import SystemMessage, ToolMessage, HumanMessage, AIMessage

load_dotenv()

from langchain_core.tools import tool

@tool
def search_web(query: str) -> str:
    """Search the web for up-to-date information, statistics, or current trends on a topic."""
    return TavilySearch(max_results=3).invoke(query)

tools = [search_web]

writer_llm = ChatGoogleGenerativeAI(
    model="gemini-3.1-flash-lite",
    temperature=0.7
)


writer_llm_tools= writer_llm.bind_tools(tools)

reviewer_llm = ChatGroq(
    model_name="llama-3.3-70b-versatile",
    temperature=0.2
)

#State
class State(TypedDict):
    topic: str
    messages: Annotated[list,add_messages]
    draft: str
    review_feedback: str
    is_approved: bool
    attempt: int


#Nodes

WRITER_SYSTEM_PROMPT = (
    "You are an expert LinkedIn content writer. Your job is to write "
    "engaging, professional LinkedIn posts about the given topic. "
    "If you have already received feedback on a "
    "previous draft, carefully address every point in the new draft. "
    "Rules for good LinkedIn posts: strong hook in the first line, "
    "1 clear takeaway, easy to skim (short paragraphs), around "
    "150–200 words, ends with a question or call-to-action to invite "
    "engagement. Do not use hashtags."
)

def writer_node(state: State) -> dict:
    """Writes/ Rewrites the LinkedIn post using tavily to search first"""
    messages = state.get("messages", [])
    attempt = state.get("attempt", 0)
    topic = state['topic']
    previous_feedback = state.get('review_feedback', None)

    # Check if we are resuming from a tool execution
    if messages and isinstance(messages[-1], ToolMessage):
        # We are continuing the current attempt after a tool call.
        # Do not increment attempt. Do not add a new user message.
        # Just run the LLM with the existing messages.
        sys_message = SystemMessage(content=WRITER_SYSTEM_PROMPT)
        response = writer_llm_tools.invoke([sys_message] + messages)
        return {
            "messages": [response]
        }
    else:
        # We are starting a new attempt (either first attempt or rewrite)
        attempt += 1
        if attempt == 1:
            user_message = f"Write a LinkedIn post on this topic: {topic}"
        else:
            user_message = (
                f"Your previous draft on '{topic}' was rejected.\n"
                f"Here is the reviewer's feedback:\n\n{previous_feedback}\n\n"
                f"Write a new, improved draft that fixes every issue mentioned. "
                f"Do not repeat the same mistakes."
            )
        
        sys_message = SystemMessage(content=WRITER_SYSTEM_PROMPT)
        user_msg_obj = HumanMessage(content=user_message)
        
        response = writer_llm_tools.invoke([sys_message] + messages + [user_msg_obj])
        return {
            "messages": [user_msg_obj, response],
            "attempt": attempt
        }

tool_node = ToolNode(tools)

def extract_draft_node(state:State) -> dict:
    """After the writer finishes tool calls, pulls the final text out as the draft."""
    last_message = state['messages'][-1]
    content = last_message.content
    
    # Extract text content only
    if isinstance(content, str):
        draft = content
    elif isinstance(content, list):
        text_parts = []
        for part in content:
            if isinstance(part, dict) and 'text' in part:
                text_parts.append(part['text'])
            elif isinstance(part, str):
                text_parts.append(part)
        draft = "\n".join(text_parts)
    elif isinstance(content, dict) and 'text' in content:
        draft = content['text']
    elif hasattr(content, 'text'):
        draft = content.text
    else:
        draft = str(content)
    
    print(f"\n\n generated post \n {draft} \n ")
    return {"draft" : draft}
    
REVIEWER_SYSTEM_PROMPT = (
    "You are a strict LinkedIn content reviewer. You judge whether a "
    "post is publish-ready. Evaluate against these criteria:\n"
    "1. Strong hook in the first line\n"
    "2. One clear, valuable takeaway\n"
    "3. Easy to skim — uses short paragraphs\n"
    "4. Roughly 150-200 words\n"
    "5. Ends with an engaging question or CTA\n"
    "6. Professional but human tone (not corporate-robotic)\n"
    "7. No hashtags\n\n"
    "Respond in exactly this format:\n"
    "VERDICT: APPROVED or REJECTED\n"
    "FEEDBACK: <one short paragraph explaining why>\n\n"
    "Be strict but fair. Approve only if the post genuinely meets all "
    "criteria. Reject if even one criterion is clearly missing."
)

def reviewer_node(state:State) -> dict:
    """Reviews the draft and decides: approve or reject with feedback."""
    draft = state['draft']

    prompt = (
        f"review this LinkedIn post draft : \n"
        f"{draft}\n"
        f"give your reviews"
    )
    response = reviewer_llm.invoke(
        [("system",REVIEWER_SYSTEM_PROMPT),("human",prompt)]
    )
    review_text = response.content.strip()
    
    # Parse verdict robustly by extracting the line starting with VERDICT
    verdict_line = ""
    for line in review_text.splitlines():
        if "VERDICT:" in line.upper():
            verdict_line = line
            break
            
    is_approved = "APPROVED" in verdict_line.upper()

    if "FEEDBACK:" in review_text:
        feedback = review_text.split("FEEDBACK:", 1)[1].strip()
    else:
        feedback = review_text

    verdict = "APPROVED" if is_approved else "REJECTED"
    print(f"[Verdict: {verdict}]")
    print(f"[Feedback: {feedback}]")

    return {
        "review_feedback": feedback,
        "is_approved": is_approved,
    }

#router function 

def should_use_tool(state:State):
    last_message = state['messages'][-1]

    if getattr(last_message,'tool_calls',None):
        return "tools"
    return "extract_draft"

def should_stop_looping(state:State):
    # Only proceed to next draft if we have a review result
    if state['is_approved']:
        print("post has been approved \n")
        return END
    if state['attempt'] >= 3:
        print("reached max attempts")
        return END 
    # Only go back to writer if we have review feedback
    if state.get('review_feedback'):
        print("proceeding to next draft with feedback")
        return "writer"
    # If no feedback yet, something went wrong - end the workflow
    print("no review feedback available, ending workflow")
    return END

#build the graph 
graph = StateGraph(State)

graph.add_node("writer",writer_node)
graph.add_node("tools",tool_node)
graph.add_node("extract_draft",extract_draft_node)
graph.add_node("reviewer",reviewer_node)

graph.add_edge(START,"writer")

graph.add_conditional_edges(
    
    "writer",should_use_tool,
)

graph.add_edge("tools", "writer")
graph.add_edge("extract_draft", "reviewer")

graph.add_conditional_edges(
    "reviewer",should_stop_looping
)

app = graph.compile()


if __name__ == "__main__":
    print("=" * 55)
    print("Welcome to the LinkedIn Post Generator")
    print("=" * 55)
    print("\nThis tool will draft a LinkedIn post for you, review it")
    print("itself, and iterate until it's publish-ready.")

    print("=" * 55)

    import sys
    topic = " ".join(sys.argv[1:]).strip() if len(sys.argv) > 1 else input("\nWhat topic do you want a LinkedIn post about?\n> ").strip()

    if not topic:
        print("\nNo topic given. Exiting.")
    else:
        print("\nStarting generation...\n")

        initial_state = {
            "topic": topic,
            "messages": [],
            "draft": "",
            "review_feedback": "",
            "is_approved": False,
            "attempt": 0,
        }

        final_state = app.invoke(initial_state)

        print("\n" + "=" * 55)
        print("FINAL LINKEDIN POST")
        print("=" * 55)
        print(final_state["draft"])
        print("=" * 55)
        print(f"Total attempts: {final_state['attempt']}")
        print(f"Approved: {final_state['is_approved']}")