import { larkClient, getTenantAccessToken } from './client';
import { processMarkdownImages, uploadLocalFilesInMarkdown } from './media';
import { ActiveTurn } from '../types';

export async function createCardKitCard(cardContent: any): Promise<string> {
  const token = await getTenantAccessToken();
  const res = await fetch("https://open.feishu.cn/open-apis/cardkit/v1/cards", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`
    },
    body: JSON.stringify({
      type: "card_json",
      data: JSON.stringify(cardContent)
    })
  });
  const data: any = await res.json();
  console.log(`[DEBUG] createCardKitCard response: ${JSON.stringify(data)}`);
  if (data.code !== 0) {
    throw new Error(`Failed to create CardKit card: ${data.msg}`);
  }
  return data.data.card_id;
}

export async function sendCardKitMessage(chatId: string, cardId: string): Promise<string> {
  let attempts = 0;
  const maxAttempts = 6;
  while (true) {
    try {
      const res = await larkClient.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify({
            type: "card",
            data: {
              card_id: cardId
            }
          })
        }
      });
      return res.data?.message_id || "";
    } catch (err: any) {
      attempts++;
      const errData = err.response?.data;
      const isCardInvalid = errData?.code === 230099 || 
                            (errData?.msg && errData.msg.includes("cardid is invalid")) ||
                            (err.message && err.message.includes("400")) ||
                            err.code === 'ERR_BAD_REQUEST';
      if (attempts >= maxAttempts || !isCardInvalid) {
        throw err;
      }
      const delay = attempts * 500;
      console.warn(`[DEBUG] sendCardKitMessage failed (card_id: ${cardId}), retrying in ${delay}ms (attempt ${attempts}/${maxAttempts}). Error: ${err.message || err}`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

export async function sendSimpleStatusCard(chatId: string, title: string, template: string, markdownContent: string): Promise<string> {
  try {
    const cardLayout = {
      schema: "2.0",
      config: {
        wide_screen_mode: true
      },
      header: {
        template: template,
        title: {
          tag: "plain_text",
          content: title
        }
      },
      body: {
        elements: [
          {
            tag: "div",
            text: {
              tag: "lark_md",
              content: markdownContent
            }
          }
        ]
      }
    };
    const cardId = await createCardKitCard(cardLayout);
    return await sendCardKitMessage(chatId, cardId);
  } catch (err: any) {
    console.error('Failed to send simple status card, falling back to text:', err);
    const res = await larkClient.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text: `[${title}] ${markdownContent}` })
      }
    });
    return res.data?.message_id || "";
  }
}

export async function streamCardKitElement(cardId: string, elementId: string, content: string, sequence: number, turn?: ActiveTurn) {
  try {
    const processedContent = await processMarkdownImages(content || " ");
    const token = await getTenantAccessToken();
    let lastError: any;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const res = await fetch(`https://open.feishu.cn/open-apis/cardkit/v1/cards/${encodeURIComponent(cardId)}/elements/${encodeURIComponent(elementId)}/content`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`
          },
          body: JSON.stringify({
            content: processedContent,
            sequence: sequence
          })
        });
        const data: any = await res.json();
        if (data.code === 0) {
          return;
        } else {
          if (data.msg && (data.msg.includes('streaming mode is closed') || data.msg.includes('streaming_mode is closed'))) {
            if (turn) turn.streamingClosed = true;
            return;
          } else if (data.code === 300313 && attempt < 15) {
            lastError = data;
            await new Promise(resolve => setTimeout(resolve, 200));
            continue;
          } else {
            console.error(`Failed to stream CardKit element ${elementId}:`, JSON.stringify(data));
            return false;
          }
        }
      } catch (e) {
        if (attempt < 15) {
          lastError = e;
          await new Promise(resolve => setTimeout(resolve, 200));
        } else {
          console.error(`Failed to stream element ${elementId} network request:`, e);
          return false;
        }
      }
    }
  } catch (e) {
    console.error(`Failed to stream element ${elementId} globally:`, e);
  }
}

export async function batchUpdateCardKitElements(cardId: string, actions: any[], sequence: number) {
  try {
    const token = await getTenantAccessToken();
    const res = await fetch(`https://open.feishu.cn/open-apis/cardkit/v1/cards/${encodeURIComponent(cardId)}/batch_update`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify({
        actions: JSON.stringify(actions),
        sequence: sequence
      })
    });
    const data: any = await res.json();
    if (data.code !== 0) {
      console.error(`Failed to batch update CardKit elements for ${cardId}:`, data.msg);
    }
  } catch (e) {
    console.error(`Failed to batch update elements network request:`, e);
  }
}

export async function updateCardKitCard(cardId: string, cardContent: any, sequence: number) {
  try {
    const token = await getTenantAccessToken();
    const res = await fetch(`https://open.feishu.cn/open-apis/cardkit/v1/cards/${encodeURIComponent(cardId)}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify({
        card: {
          type: "card_json",
          data: JSON.stringify(cardContent)
        },
        sequence: sequence
      })
    });
    const data: any = await res.json();
    if (data.code !== 0) {
      console.error(`Failed to update CardKit card ${cardId}:`, data.msg);
    }
  } catch (e) {
    console.error(`Failed to update CardKit card ${cardId} network request:`, e);
  }
}

export async function finalizeCardKitCard(cardId: string, finalContent: any, turn: ActiveTurn) {
  try {
    const token = await getTenantAccessToken();
    
    if (turn) turn.streamingClosed = true;
    
    // 1. Close streaming mode
    const settingsRes = await fetch(`https://open.feishu.cn/open-apis/cardkit/v1/cards/${encodeURIComponent(cardId)}/settings`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify({
        settings: JSON.stringify({ streaming_mode: false }),
        sequence: turn.sequence++
      })
    });
    const settingsData: any = await settingsRes.json();
    if (settingsData.code !== 0) {
      console.error(`Failed to close streaming mode for card ${cardId}:`, settingsData.msg);
    }

    // 2. Put final full card json
    const updateRes = await fetch(`https://open.feishu.cn/open-apis/cardkit/v1/cards/${encodeURIComponent(cardId)}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify({
        card: {
          type: "card_json",
          data: JSON.stringify(finalContent)
        },
        sequence: turn.sequence++
      })
    });
    const updateData: any = await updateRes.json();
    if (updateData.code !== 0) {
      console.error(`Failed to finalize CardKit card ${cardId}:`, updateData.msg);
    }
    if (turn.status === 'success' && !turn.filesUploaded) {
      turn.filesUploaded = true;
      uploadLocalFilesInMarkdown(turn.answer || '', turn.chatId, cardId).catch(console.error);
    }
  } catch (e) {
    console.error(`Failed to finalize CardKit card network request:`, e);
  }
}
