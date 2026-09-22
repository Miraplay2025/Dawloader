const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e8 }); // Suporte para envio de arquivos pesados

// Configura o armazenamento do upload temporário de áudio
const upload = multer({ dest: 'uploads/' });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Endpoint para receber formulário inicial com áudio e cookies
app.post('/api/start', upload.single('audio'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Arquivo de áudio não enviado.' });
  }
  res.json({ success: true, audioPath: req.file.path });
});

// Mecanismo de Pausa/Aguardo de confirmação do usuário
function aguardarConfirmacaoUsuario(socket) {
  return new Promise((resolve) => {
    socket.emit('log', '⏸️ **Aguardando confirmação do usuário no painel...**');
    socket.emit('solicitar_confirmacao');
    socket.once('usuario_confirmou', () => {
      socket.emit('log', '▶️ Confirmação recebida! Prosseguindo para o próximo passo...');
      resolve();
    });
  });
}

// Emissão de Logs e Screenshots
async function capturarEEnviarScreenshot(page, socket, mensagemLog) {
  socket.emit('log', mensagemLog);
  const screenshotBase64 = await page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 70 });
  socket.emit('screenshot', `data:image/jpeg;base64,${screenshotBase64}`);
}

io.on('connection', (socket) => {
  socket.emit('log', '⚡ Conectado ao servidor de automação via WebSocket.');

  socket.on('iniciar_automacao', async (dados) => {
    const { targetUrl, cookies, audioPath } = dados;
    let browser = null;

    try {
      socket.emit('log', '🚀 Iniciando navegador Chromium (Modo Headless leve)...');

      browser = await puppeteer.launch({
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
        headless: 'new',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
          '--window-size=1280,800'
        ]
      });

      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 800 });

      // 1. Injetar Cookies de Sessão
      socket.emit('log', '🔑 Injetando cookies de sessão...');
      let cookiesParsed = typeof cookies === 'string' ? JSON.parse(cookies) : cookies;
      
      // Ajusta formato caso venha de extensões padrão do Chrome
      if (Array.isArray(cookiesParsed)) {
        for (let cookie of cookiesParsed) {
          if (cookie.sameSite) {
            const sameSiteLower = cookie.sameSite.toLowerCase();
            if (['strict', 'lax', 'none'].includes(sameSiteLower)) {
              cookie.sameSite = sameSiteLower.charAt(0).toUpperCase() + sameSiteLower.slice(1);
            } else {
              delete cookie.sameSite;
            }
          }
          await page.setCookie(cookie);
        }
      }

      // 2. Acessar Página
      socket.emit('log', `🌐 Navegando para: ${targetUrl}`);
      await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });

      // 3. Desativar Legendas (Se estiver ON)
      socket.emit('log', '🔍 Verificando status das legendas...');
      await page.waitForSelector('.curImg__subtitle_text', { timeout: 15000 });

      const legendasAtivas = await page.evaluate(() => {
        const el = document.querySelector('.curImg__subtitle_text');
        return el && el.innerText.trim().toUpperCase() === 'ON';
      });

      if (legendasAtivas) {
        socket.emit('log', '⚙️ Legendas ativas detectadas ("ON"). Clicando para desativar...');
        
        // Clique robusto via elemento pai/botão
        await page.evaluate(() => {
          const el = document.querySelector('.curImg__subtitle_text');
          if (el) {
            const botao = el.closest('div') || el.closest('button') || el.parentElement;
            botao.click();
          }
        });

        // Aguarda a transição para OFF
        await page.waitForFunction(() => {
          const el = document.querySelector('.curImg__subtitle_text');
          return el && el.innerText.trim().toUpperCase() === 'OFF';
        }, { timeout: 10000 });

        socket.emit('log', '✅ Legendas desativadas com sucesso ("OFF").');
      } else {
        socket.emit('log', 'ℹ️ Legendas já estavam desativadas ou não necessitam de alteração.');
      }

      // Captura Print após ajustar legendas
      await capturarEEnviarScreenshot(page, socket, '📸 Screenshot obtido após desativar legendas.');
      await aguardarConfirmacaoUsuario(socket);

      // 4. Selecionar Aba de Upload de Áudio
      socket.emit('log', '🎵 Selecionando opção de Upload de Áudio...');
      
      // Clique via evaluate para garantir reconhecimento do clique pelo site
      await page.evaluate(() => {
        const tabEnviar = document.querySelector('.input_area_tabitem[data-index="1"]');
        if (tabEnviar) tabEnviar.click();
      });

      await page.waitForTimeout(1000);

      // 5. Injeção e Upload do Arquivo de Áudio
      socket.emit('log', '📁 Injetando o arquivo de áudio no campo de upload...');
      
      // Localiza o <input type="file"> interno associado à área de upload
      const fileInputHandle = await page.waitForSelector('input[type="file"][accept*="audio"], input[type="file"]', { timeout: 10000 });
      
      // Caminho absoluto do áudio temporário no servidor Node.js
      const absoluteAudioPath = path.resolve(audioPath);

      // Envia o arquivo diretamente ao input do navegador
      await fileInputHandle.uploadFile(absoluteAudioPath);
      socket.emit('log', '⬆️ Arquivo de áudio enviado ao navegador. Aguardando processamento...');

      // 6. Aguardar Carregamento Completo do Áudio
      socket.emit('log', '⏳ Aguardando confirmação do carregamento do áudio na interface...');
      await page.waitForSelector('.upload_audio_time', { timeout: 60000 });

      socket.emit('log', '✅ Áudio carregado e processado com sucesso!');

      // Captura Print após carregar áudio
      await capturarEEnviarScreenshot(page, socket, '📸 Screenshot obtido após o upload e carregamento do áudio.');
      await aguardarConfirmacaoUsuario(socket);

      // 7. Clicar em "Criar Avatar Falante Online Grátis"
      socket.emit('log', '🤖 Clicando no botão para gerar o Avatar Falante...');

      const clicouGerar = await page.evaluate(() => {
        const elementos = Array.from(document.querySelectorAll('.tptab-span, button, div, span'));
        const botao = elementos.find(el => el.innerText && el.innerText.includes('Criar Avatar Falante Online Grátis'));
        if (botao) {
          botao.click();
          return true;
        }
        return false;
      });

      if (!clicouGerar) {
        throw new Error('Botão "Criar Avatar Falante Online Grátis" não foi encontrado na página.');
      }

      // 8. Aguardar Redirecionamento da Página
      socket.emit('log', '🔄 Aguardando redirecionamento para a página de geração do vídeo...');
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 });

      // Captura Print na nova página
      await capturarEEnviarScreenshot(page, socket, '🎉 Redirecionamento concluído! O vídeo está sendo gerado.');
      socket.emit('log', '🏆 Processo concluído com sucesso!');

    } catch (err) {
      socket.emit('log', `❌ ERRO duranta a execução: ${err.message}`);
    } finally {
      // Limpeza do arquivo de áudio temporário
      if (audioPath && fs.existsSync(audioPath)) {
        fs.unlinkSync(audioPath);
      }
      if (browser) {
        await browser.close();
        socket.emit('log', '🔒 Navegador fechado.');
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
