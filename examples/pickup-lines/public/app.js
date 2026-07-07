const textInput = document.querySelector('#source-text');
const connectionSelect = document.querySelector('#connection-select');
const modelInput = document.querySelector('#model-input');
const generateButton = document.querySelector('#generate-button');
const lineOutput = document.querySelector('#line-output');
const copyButton = document.querySelector('#copy-button');
const status = document.querySelector('#status');
const ideaButtons = document.querySelector('#idea-buttons');

const ideas = [
  'My ideal Sunday involves a bookstore, a strong coffee, and nowhere to be.',
  'I make an unbelievably good breakfast burrito.',
  'I am trying to learn every shortcut in my favorite video game.',
  'My cat has a tiny mustache and a lot of opinions.',
];

function setStatus(message) {
  status.textContent = message;
}

function setLoading(loading) {
  generateButton.disabled = loading;
  generateButton.textContent = loading ? 'Flirting...' : 'Make it flirty';
}

function addIdeas() {
  for (const idea of ideas) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'idea';
    button.textContent = idea;
    button.addEventListener('click', () => {
      textInput.value = idea;
      textInput.focus();
      setStatus('Example loaded. Make it yours, or let it ride.');
    });
    ideaButtons.append(button);
  }
}

async function bootstrap() {
  const response = await fetch('/api/meta');
  const meta = await response.json();
  if (!response.ok) throw new Error(meta.error || 'Could not load connections.');

  for (const connection of meta.connections) {
    const option = document.createElement('option');
    option.value = connection.id;
    option.textContent = `${connection.label} (${connection.provider})`;
    option.dataset.model = connection.defaultModel;
    connectionSelect.append(option);
  }

  if (!meta.connections.length) {
    generateButton.disabled = true;
    setStatus('Set OPENAI_API_KEY, ANTHROPIC_API_KEY, or GOOGLE_API_KEY — or run local Ollama — to begin.');
    return;
  }

  modelInput.value = meta.connections[0].defaultModel;
  connectionSelect.addEventListener('change', () => {
    modelInput.value = connectionSelect.selectedOptions[0].dataset.model;
  });
}

generateButton.addEventListener('click', async () => {
  const text = textInput.value.trim();
  if (!text) {
    textInput.focus();
    setStatus('Give the generator a little something to work with.');
    return;
  }

  setLoading(true);
  setStatus('Finding the charming angle...');
  lineOutput.textContent = '…';

  try {
    const response = await fetch('/api/pickup-line', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text,
        connectionId: connectionSelect.value,
        model: modelInput.value.trim(),
      }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Generation failed.');

    lineOutput.textContent = payload.line;
    copyButton.disabled = false;
    setStatus(`Made in ${payload.timing.totalMs} ms with ${payload.source.provider}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Generation failed.';
    lineOutput.textContent = 'Try a different thought, and we will take another swing at it.';
    copyButton.disabled = true;
    setStatus(message);
  } finally {
    setLoading(false);
  }
});

copyButton.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(lineOutput.textContent);
    setStatus('Copied. Go be brave.');
  } catch {
    setStatus('Could not copy automatically — select the line and copy it manually.');
  }
});

addIdeas();
bootstrap().catch((error) => {
  const message = error instanceof Error ? error.message : 'Startup failed.';
  setStatus(message);
});
