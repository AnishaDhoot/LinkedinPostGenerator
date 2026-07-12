import os
from typing import TypedDict, Annotated, Literal
from langgraph.graph import StateGraph,START,END
from langgraph.graph.message import add_messages
from langgraph.prebuilt import ToolNode
from langchain_groq import ChatGroq
from langchain_tavily import TavilySearch
from dotenv import load_dotenv
from langchain_google_genai import ChatGoogleGenerativeAI

load_dotenv()

from langchain_core.tools import tool

@tool
def search_web(query: str) -> str:
    """Search the web for up-to-date information, statistics, or current trends on a topic."""
    return TavilySearch(max_results=3).invoke(query)

tools = [search_web]

writer_llm = ChatGoogleGenerativeAI(
    model="gemini-3.5-flash",
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

def writer_node(state: State)-> dict:
    """Writes/ Rewrites the LinkedIn post using tavily to search first"""
    attempt = state.get("attempt", 0) + 1
    topic= state['topic']
    previous_feedback = state.get('review_feedback', None)

    if attempt==1:
        user_message = f"Write a LinkedIn post on this topic: {topic}"
    else:
        user_message = (
            f"your previous draft on '{topic}' was rejected"
            f"Here is the reviewer's feedback \n\n {previous_feedback}\n\n"
            f"Write a new, improved draft that fixes every issue mentiond"
            f"do not repeat the same mistake"
        )
    messages = [("system", WRITER_SYSTEM_PROMPT), ("user", user_message)]
    response=writer_llm_tools.invoke(messages)
    return{
            "messages" : [("human",user_message),response],
            "attempt" : attempt
    }

tool_node = ToolNode(tools)

def extract_draft_node(state:State) -> dict:
    """After the writer finishes tool calls, pulls the final text out as the draft."""
    last_message = state['messages'][-1]
    content = last_message.content
    
    # Extract text content only
    if isinstance(content, dict) and 'text' in content:
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
    
    is_approved = "APPROVED" in review_text.upper().split("FEEDBACK")[0]

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