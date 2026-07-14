"use client";

import { useState, useEffect, useRef } from "react";

export default function Home() {
  const [topic, setTopic] = useState("");
  const [iterations, setIterations] = useState([]);
  const [approvedPost, setApprovedPost] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [apiOnline, setApiOnline] = useState(false);
  const [copied, setCopied] = useState(false);
  const [previewMode, setPreviewMode] = useState("light");

  const chatEndRef = useRef(null);

  // Auto-scroll to the bottom of the iteration history
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [iterations]);

  // Backend Health Checker
  useEffect(() => {
    const checkHealth = async () => {
      try {
        const res = await fetch("http://127.0.0.1:8000/api/health");
        if (res.ok) {
          setApiOnline(true);
        } else {
          setApiOnline(false);
        }
      } catch (err) {
        setApiOnline(false);
      }
    };
    checkHealth();
    const interval = setInterval(checkHealth, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleCopyPost = () => {
    if (!approvedPost) return;
    navigator.clipboard.writeText(approvedPost);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleReset = () => {
    setIterations([]);
    setApprovedPost(null);
    setError(null);
    setTopic("");
  };

  const handleSuggestionClick = (suggestedTopic) => {
    setTopic(suggestedTopic);
  };

  const handleGenerate = async (e) => {
    if (e) e.preventDefault();
    if (!topic.trim() || loading) return;

    setLoading(true);
    setError(null);
    setIterations([]);
    setApprovedPost(null);

    try {
      const response = await fetch("http://127.0.0.1:8000/api/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ topic: topic.trim() }),
      });

      if (!response.ok) {
        throw new Error("Failed to connect to the generator service. Verify the backend is running.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop(); // keep incomplete line in buffer

        for (const line of lines) {
          const cleanLine = line.trim();
          if (cleanLine.startsWith("data: ")) {
            const dataStr = cleanLine.slice(6).trim();
            if (!dataStr) continue;

            const data = JSON.parse(dataStr);
            if (data.status === "completed") {
              setLoading(false);
              break;
            }
            if (data.status === "error") {
              setError(data.message);
              setLoading(false);
              break;
            }

            // Process node updates
            processNodeUpdates(data);
          }
        }
      }
    } catch (err) {
      console.error(err);
      setError(err.message || "An unexpected error occurred during execution.");
      setLoading(false);
    }
  };

  const processNodeUpdates = (data) => {
    // 1. Writer Node updates
    if (data.writer) {
      const attemptNum = data.writer.attempt || 1;
      let searchQuery = null;
      const messages = data.writer.messages || [];
      const lastMsg = messages[messages.length - 1];
      if (lastMsg && lastMsg.tool_calls && lastMsg.tool_calls.length > 0) {
        searchQuery = lastMsg.tool_calls[0].args.query;
      }

      setIterations((prev) => {
        const existingIdx = prev.findIndex((it) => it.number === attemptNum);
        if (existingIdx !== -1) {
          const updated = [...prev];
          updated[existingIdx] = {
            ...updated[existingIdx],
            searchQuery: searchQuery || updated[existingIdx].searchQuery,
            status: searchQuery ? "searching" : "drafting",
          };
          return updated;
        } else {
          return [
            ...prev,
            {
              number: attemptNum,
              searchQuery,
              searchResult: null,
              draft: null,
              verdict: "PENDING",
              feedback: null,
              status: searchQuery ? "searching" : "drafting",
            },
          ];
        }
      });
    }

    // 2. Tools Node updates (Tavily search returns)
    if (data.tools) {
      const messages = data.tools.messages || [];
      const toolMsg = messages[messages.length - 1];
      const searchResult = toolMsg ? toolMsg.content : "";

      setIterations((prev) => {
        const updated = [...prev];
        if (updated.length > 0) {
          updated[updated.length - 1] = {
            ...updated[updated.length - 1],
            searchResult,
            status: "drafting",
          };
        }
        return updated;
      });
    }

    // 3. Extract Draft Node updates
    if (data.extract_draft) {
      const draft = data.extract_draft.draft;

      setIterations((prev) => {
        const updated = [...prev];
        if (updated.length > 0) {
          updated[updated.length - 1] = {
            ...updated[updated.length - 1],
            draft,
            status: "reviewing",
          };
        }
        return updated;
      });
    }

    // 4. Reviewer Node updates
    if (data.reviewer) {
      const feedback = data.reviewer.review_feedback;
      const isApproved = data.reviewer.is_approved;
      const verdict = isApproved ? "APPROVED" : "REJECTED";

      setIterations((prev) => {
        const updated = [...prev];
        if (updated.length > 0) {
          updated[updated.length - 1] = {
            ...updated[updated.length - 1],
            feedback,
            verdict,
            status: "done",
          };
        }
        return updated;
      });

      if (isApproved) {
        setIterations((prev) => {
          const lastIt = prev[prev.length - 1];
          if (lastIt && lastIt.draft) {
            setApprovedPost(lastIt.draft);
          }
          return prev;
        });
      }
    }
  };

  return (
    <div className="app-container">
      {/* 1. SIDEBAR CONFIG */}
      <aside className="sidebar">
        <div className="logo-section">
          {/* Glowing Premium Shield Logo */}
          <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ width: '32px', height: '32px', filter: 'drop-shadow(0 4px 8px rgba(99, 102, 241, 0.35))' }}>
            <rect width="32" height="32" rx="10" fill="url(#logo-grad)" />
            <path d="M16 6L24 9.5V15.5C24 20 20.5 23 16 24.5C11.5 23.0 8 20.0 8 15.5V9.5L16 6Z" fill="white" fillOpacity="0.15" stroke="white" strokeWidth="1.5" />
            <defs>
              <linearGradient id="logo-grad" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
                <stop stopColor="#6366F1" />
                <stop offset="1" stopColor="#8b5cf6" />
              </linearGradient>
            </defs>
          </svg>
          <span className="logo-title">LinkedIn Post AI</span>
        </div>

        <div className="sidebar-section">
          <h3 className="sidebar-title">Server Status</h3>
          <div className="sidebar-config-card">
            <div className="sidebar-config-row" style={{ display: 'flex', alignItems: 'center' }}>
              <span>FastAPI API:</span>
              <div style={{ display: 'flex', alignItems: 'center', marginLeft: 'auto' }}>
                <span className={`status-dot ${apiOnline ? 'online' : 'offline'}`}></span>
                <span style={{ fontWeight: 600, color: apiOnline ? '#10b981' : '#ef4444' }}>
                  {apiOnline ? 'Online' : 'Offline'}
                </span>
              </div>
            </div>
            <div style={{ fontSize: '0.75rem', opacity: 0.7, marginTop: '4px' }}>Host: 127.0.0.1:8000</div>
          </div>
        </div>

        <div className="sidebar-section">
          <h3 className="sidebar-title">Agent Settings</h3>
          <div className="sidebar-config-card" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div className="sidebar-config-row">
              <span style={{ opacity: 0.8 }}>Writer LLM:</span>
              <span style={{ fontWeight: 600, color: '#a78bfa' }}>Llama-3.3-70B</span>
            </div>
            <div className="sidebar-config-row">
              <span style={{ opacity: 0.8 }}>Reviewer LLM:</span>
              <span style={{ fontWeight: 600, color: '#a78bfa' }}>Llama-3.3-70B</span>
            </div>
            <div className="sidebar-config-row">
              <span style={{ opacity: 0.8 }}>Search Tool:</span>
              <span style={{ fontWeight: 600 }}>Tavily Search</span>
            </div>
            <div className="sidebar-config-row">
              <span style={{ opacity: 0.8 }}>Workflow:</span>
              <span style={{ fontWeight: 600 }}>Iterative (ReAct)</span>
            </div>
          </div>
        </div>

        <div className="sidebar-section" style={{ flexGrow: 1 }}>
          <h3 className="sidebar-title">Quick Topics</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <button className="suggestion-card" onClick={() => handleSuggestionClick("The Future of AI Internships in Tech")}>
              🎓 AI Internships in Tech
            </button>
            <button className="suggestion-card" onClick={() => handleSuggestionClick("Why Clean Code Matters for Agentic Workflows")}>
              💻 Clean Code for Agents
            </button>
            <button className="suggestion-card" onClick={() => handleSuggestionClick("How to Navigate Quota Limits in LLM APIs")}>
              ⚠️ Navigating Quotas in LLMs
            </button>
          </div>
        </div>

        <div className="sidebar-section" style={{ marginBottom: 0 }}>
          <button className="btn-action btn-secondary" onClick={handleReset}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
            Reset Workspace
          </button>
        </div>
      </aside>

      {/* 2. CHAT PANEL WORKSPACE */}
      <section className="chat-workspace">
        <header className="chat-header">
          <div>
            <h2 className="chat-header-title">LinkedIn Drafting Workspace</h2>
            <div style={{ fontSize: '0.75rem', color: '#94a3b8', marginTop: '2px' }}>
              Multi-Agent Collaborative Post Generator
            </div>
          </div>
          {!apiOnline && (
            <div style={{ background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', border: '1px solid rgba(239, 68, 68, 0.2)', fontSize: '0.75rem', padding: '6px 12px', borderRadius: '8px', fontWeight: 'bold' }}>
              ⚠️ Start Python FastAPI Backend (main.py)
            </div>
          )}
        </header>

        <div className="chat-history">
          {iterations.length === 0 ? (
            <div className="welcome-box">
              <h2 className="welcome-title">Post Generator Workspace</h2>
              <p className="welcome-desc">
                Enter a topic, and watch the collaborative agents run in real-time. The **Writer agent** will search Tavily, write a draft, and the **Reviewer agent** will evaluate and provide critical feedback until the post is approved!
              </p>
              <div className="suggestions-grid">
                <button className="suggestion-card" onClick={() => handleSuggestionClick("Three trends in Agentic Workflows for 2026")}>
                  🤖 Agentic Workflow Trends
                </button>
                <button className="suggestion-card" onClick={() => handleSuggestionClick("The value of building side projects as a developer")}>
                  🛠️ Developer Side Projects
                </button>
              </div>
            </div>
          ) : (
            <>
              {iterations.map((it) => (
                <div key={it.number} className="iteration-card glass-panel">
                  <div className="iteration-header">
                    <span className="iteration-title">Attempt #{it.number}</span>
                    <span className={`iteration-badge ${
                      it.verdict === 'APPROVED' ? 'badge-approved' : 
                      it.verdict === 'REJECTED' ? 'badge-rejected' : 'badge-pending'
                    }`}>
                      {it.verdict}
                    </span>
                  </div>

                  <div className="iteration-body">
                    {/* Step 1: Tavily Search */}
                    {it.searchQuery && (
                      <div className="step-container">
                        <div className="step-indicator">
                          <span className={`step-circle ${it.searchResult ? 'success' : 'active'}`}>1</span>
                          <span className="step-line"></span>
                        </div>
                        <div className="step-content">
                          <div className="step-title">Writer: Web Search</div>
                          <div className="step-description">
                            Searching the web for current context: <strong style={{color: '#ffffff'}}>&quot;{it.searchQuery}&quot;</strong>
                            {it.searchResult && (
                              <div style={{ fontSize: '0.75rem', color: '#64748b', marginTop: '6px', background: 'rgba(255,255,255,0.01)', border: '1px solid rgba(255,255,255,0.03)', padding: '6px', borderRadius: '4px', maxHeight: '60px', overflowY: 'auto' }}>
                                Found results: {it.searchResult}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Step 2: Content Drafting */}
                    {it.status !== "searching" && (
                      <div className="step-container">
                        <div className="step-indicator">
                          <span className={`step-circle ${it.draft ? 'success' : 'active'}`}>2</span>
                          <span className="step-line"></span>
                        </div>
                        <div className="step-content">
                          <div className="step-title">Writer: Draft Generation</div>
                          <div className="step-description">
                            Writing the LinkedIn post draft addressing all constraints...
                            {it.draft && (
                              <div className="post-draft-preview">
                                {it.draft}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Step 3: Review */}
                    {it.draft && (
                      <div className="step-container">
                        <div className="step-indicator">
                          <span className={`step-circle ${
                            it.verdict === 'APPROVED' ? 'success' : 
                            it.verdict === 'REJECTED' ? 'fail' : 'active'
                          }`}>3</span>
                        </div>
                        <div className="step-content">
                          <div className="step-title">Reviewer: Strict Criteria Checklist</div>
                          <div className="step-description">
                            Evaluating draft hook, skim-readability, question CTA, word count, and tone...
                            {it.feedback && (
                              <div className={`feedback-box ${it.verdict === 'APPROVED' ? 'approved' : 'rejected'}`}>
                                <strong>Verdict: {it.verdict}</strong>
                                <p style={{ marginTop: '4px' }}>{it.feedback}</p>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              ))}

              {/* Final Post Presentation */}
              {approvedPost && (
                <div className="final-post-card">
                  <div className="final-post-header">
                    <span className="final-post-title">✨ Final Approved LinkedIn Post</span>
                    <button className="btn-action btn-primary" onClick={handleCopyPost} style={{ width: 'auto', padding: '8px 16px' }}>
                      {copied ? (
                        <>Copied!</>
                      ) : (
                        <>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                            <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                          </svg>
                          Copy Draft
                        </>
                      )}
                    </button>
                  </div>
                  <div className="final-post-body">
                    <div className="linkedin-card-container">
                      <div className="linkedin-toggle-bar">
                        <span>LinkedIn Mockup Mode:</span>
                        <button 
                          className={`linkedin-toggle-btn ${previewMode === 'light' ? 'active' : ''}`}
                          onClick={() => setPreviewMode('light')}
                        >
                          Light Mode
                        </button>
                        <button 
                          className={`linkedin-toggle-btn ${previewMode === 'dark' ? 'active' : ''}`}
                          onClick={() => setPreviewMode('dark')}
                        >
                          Dark Mode
                        </button>
                      </div>

                      {/* Mockup LinkedIn Card */}
                      <div className={`linkedin-card ${previewMode === 'dark' ? 'dark-mode-preview' : ''}`}>
                        <div className="linkedin-header">
                          <div className="linkedin-avatar">AI</div>
                          <div className="linkedin-meta">
                            <span className="linkedin-name">LinkedIn Post AI</span>
                            <span className="linkedin-headline">Enterprise Agentic Content specialist • 2nd</span>
                            <span className="linkedin-time">
                              Just now • 🌐
                            </span>
                          </div>
                        </div>
                        <div className="linkedin-body">
                          {approvedPost}
                        </div>
                        <div className="linkedin-stats">
                          <div className="linkedin-reactions">
                            👍❤️💡 124 reactions
                          </div>
                          <div>
                            12 comments • 4 reposts
                          </div>
                        </div>
                        <div className="linkedin-actions">
                          <button className="linkedin-action-btn">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: '4px' }}>
                              <path d="M14 9V5a3 3 0 00-3-3l-4 9v11h11.28a2 2 0 002-1.7l1.38-9a2 2 0 00-2-2.3zM7 22H4a2 2 0 01-2-2v-7a2 2 0 012-2h3" />
                            </svg>
                            Like
                          </button>
                          <button className="linkedin-action-btn">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: '4px' }}>
                              <path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z" />
                            </svg>
                            Comment
                          </button>
                          <button className="linkedin-action-btn">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: '4px' }}>
                              <path d="M17 2.1l4 4-4 4M3 22v-6a6 6 0 016-6h12" />
                            </svg>
                            Repost
                          </button>
                          <button className="linkedin-action-btn">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: '4px' }}>
                              <line x1="22" y1="2" x2="11" y2="13" />
                              <polygon points="22 2 15 22 11 13 2 9 22 2" />
                            </svg>
                            Send
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {loading && !approvedPost && (
                <div style={{ display: 'flex', justifyContent: 'center', margin: '20px 0' }}>
                  <div style={{ border: '3px solid rgba(255,255,255,0.05)', borderTop: '3px solid #6366f1', borderRadius: '50%', width: '28px', height: '28px', animation: 'spin 1s linear infinite' }}></div>
                  <style jsx global>{`
                    @keyframes spin {
                      0% { transform: rotate(0deg); }
                      100% { transform: rotate(360deg); }
                    }
                  `}</style>
                </div>
              )}

              {error && (
                <div style={{ maxWidth: '900px', width: '100%', margin: '0 auto 20px auto', padding: '16px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: '12px', color: '#fca5a5', fontSize: '0.85rem' }}>
                  ❌ <strong>Error:</strong> {error}
                </div>
              )}
            </>
          )}
          <div ref={chatEndRef} />
        </div>

        {/* 3. INPUT DRAWER */}
        <div className="input-panel">
          <form onSubmit={handleGenerate} className="input-container">
            <input
              type="text"
              className="topic-input"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="What topic do you want a LinkedIn post about? (e.g. AI trends in 2026)"
              disabled={loading || !apiOnline}
            />
            <button type="submit" className="btn-send" disabled={loading || !topic.trim() || !apiOnline}>
              {loading ? (
                <>Generating...</>
              ) : (
                <>
                  Generate Post
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <line x1="22" y1="2" x2="11" y2="13" />
                    <polygon points="22 2 15 22 11 13 2 9 22 2" />
                  </svg>
                </>
              )}
            </button>
          </form>
        </div>
      </section>
    </div>
  );
}
