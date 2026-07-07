const connectionSelect = document.querySelector('#connection-select');
const modelSelect = document.querySelector('#model-select');
const forgeModeToggle = document.querySelector('#forge-mode');
const sparkButton = document.querySelector('#spark-button');
const clearButton = document.querySelector('#clear-button');
const chatForm = document.querySelector('#chat-form');
const messageInput = document.querySelector('#message-input');
const messagesEl = document.querySelector('#messages');
const statusLine = document.querySelector('#status-line');
const packageNameEl = document.querySelector('#package-name');
const packageVersionEl = document.querySelector('#package-version');
const furnaceFactEl = document.querySelector('#furnace-fact');
const heatFill = document.querySelector('#heat-fill');
const heatLabel = document.querySelector('#heat-label');

const sparkPrompts = [
  'Explain this bug like a welder teaching an apprentice.',
  'Give me a project plan with the energy of a midnight factory shift.',
  'Turn this rough idea into a polished spec sheet.',
  'Help me debug this like we are standing beside a very suspicious conveyor belt.',
  'Write a pep talk for shipping a feature before the whistle blows.',
];

const loadingLines = [
  'Charging induction coils...',
  'Polishing gears for a cleaner answer...',
  'Checking the dramatic clank tolerances...',
  'Rolling fresh steel off the line...',
];

let catalog = [];
let conversation = [];

function setStatus(text) {
  statusLine.textContent = text;
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addMessage(role, content) {
  const article = document.createElement('article');
  article.className = `message ${role}`;

  const stamp = document.createElement('div');
  stamp.className = 'message-stamp';
  stamp.textContent = role === 'user' ? 'Operator' : 'Millie';

  const body = document.createElement('div');
  body.className = 'message-body';
  body.textContent = content;

  article.append(stamp, body);
  messagesEl.append(article);
  scrollToBottom();
}

function renderWelcome() {
  messagesEl.innerHTML = '';
  addMessage(
    'assistant',
    'Millie on station. Feed me a question and I will run it through the finest conversational rollers in the plant.',
  );
}

function refreshModels() {
  const activeConnection = catalog.find((item) => item.id === connectionSelect.value) ?? catalog[0];
  modelSelect.innerHTML = '';
  for (const model of activeConnection.models) {
    const option = document.createElement('option');
    option.value = model;
    option.textContent = model;
    modelSelect.append(option);
  }
  modelSelect.value = activeConnection.defaultModel;
}

function updateHeatMeter(messageLength) {
  const heat = Math.max(14, Math.min(100, Math.round(messageLength * 1.35)));
  heatFill.style.width = `${heat}%`;
  if (heat < 35) heatLabel.textContent = 'Warm';
  else if (heat < 70) heatLabel.textContent = 'Toasty';
  else heatLabel.textContent = 'White Hot';
}

async function bootstrap() {
  const response = await fetch('/api/meta');
  const meta = await response.json();
  catalog = meta.connections;
  packageNameEl.textContent = meta.packageName;
  packageVersionEl.textContent = `v${meta.packageVersion}`;
  furnaceFactEl.textContent = meta.furnaceFact;

  for (const connection of catalog) {
    const option = document.createElement('option');
    option.value = connection.id;
    option.textContent = `${connection.label} (${connection.provider})`;
    connectionSelect.append(option);
  }

  refreshModels();
  renderWelcome();
}

connectionSelect.addEventListener('change', refreshModels);

sparkButton.addEventListener('click', () => {
  const prompt = sparkPrompts[Math.floor(Math.random() * sparkPrompts.length)];
  messageInput.value = prompt;
  messageInput.focus();
  updateHeatMeter(prompt.length);
  setStatus('Spark prompt loaded. Fresh stock on the table.');
});

clearButton.addEventListener('click', () => {
  conversation = [];
  renderWelcome();
  messageInput.value = '';
  updateHeatMeter(10);
  setStatus('Conversation deck cleared.');
});

messageInput.addEventListener('input', () => {
  updateHeatMeter(messageInput.value.length);
});

chatForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const content = messageInput.value.trim();
  if (!content) return;

  conversation.push({ role: 'user', content });
  addMessage('user', content);
  messageInput.value = '';
  updateHeatMeter(content.length);

  const loadingLine = loadingLines[Math.floor(Math.random() * loadingLines.length)];
  setStatus(loadingLine);

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        connectionId: connectionSelect.value,
        model: modelSelect.value,
        forgeMode: forgeModeToggle.checked,
        messages: conversation,
      }),
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || 'Chat request failed.');
    }

    conversation.push({ role: 'assistant', content: payload.reply });
    addMessage('assistant', payload.reply);
    furnaceFactEl.textContent = payload.furnaceFact;
    packageVersionEl.textContent = `v${payload.packageVersion}`;
    setStatus(`Reply forged in ${payload.timing.totalMs} ms via ${payload.source.provider}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    addMessage('assistant', `The line jammed: ${message}`);
    setStatus('Maintenance requested at the chat conveyor.');
  }
});

bootstrap().catch((error) => {
  const message = error instanceof Error ? error.message : 'Unknown error';
  setStatus(`Startup fault: ${message}`);
});
