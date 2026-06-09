import axios from "axios";
import { getAlertConfig } from "./config.js";

const SEVERITY_COLOURS = {
  info: "Accent",
  success: "Good",
  warning: "Warning",
  error: "Attention"
};

function cleanText(value, fallback = "") {
  return String(value || fallback).trim();
}

function buildTeamsPayload({ title, severity = "warning", summary, facts = [], actionUrl = "" }) {
  const safeTitle = cleanText(title, "Halo Xero Widget Alert");
  const safeSeverity = ["info", "success", "warning", "error"].includes(severity)
    ? severity
    : "warning";
  const factSet = facts
    .filter(fact => fact?.title && typeof fact.value !== "undefined" && fact.value !== null)
    .slice(0, 10)
    .map(fact => ({
      title: cleanText(fact.title).slice(0, 60),
      value: cleanText(fact.value, "Not available").slice(0, 250)
    }));

  const body = [
    {
      type: "TextBlock",
      text: safeTitle,
      weight: "Bolder",
      size: "Medium",
      color: SEVERITY_COLOURS[safeSeverity],
      wrap: true
    }
  ];

  if (summary) {
    body.push({
      type: "TextBlock",
      text: cleanText(summary).slice(0, 1000),
      wrap: true
    });
  }

  if (factSet.length) {
    body.push({
      type: "FactSet",
      facts: factSet
    });
  }

  const content = {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    version: "1.4",
    body
  };

  if (actionUrl) {
    content.actions = [
      {
        type: "Action.OpenUrl",
        title: "Open Admin",
        url: actionUrl
      }
    ];
  }

  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content
      }
    ]
  };
}

export async function sendAdminAlert(alert) {
  const config = getAlertConfig();

  if (!config.enabled || !config.teamsWebhookUrl) {
    return {
      sent: false,
      skipped: true,
      reason: config.enabled ? "teams_webhook_not_configured" : "alerts_disabled"
    };
  }

  await axios.post(config.teamsWebhookUrl, buildTeamsPayload(alert), {
    headers: {
      "Content-Type": "application/json"
    },
    timeout: 10000
  });

  return {
    sent: true,
    skipped: false
  };
}
