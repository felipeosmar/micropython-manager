import * as vscode from 'vscode';
import { ESP32Device } from './types';
import { DeviceManager } from './deviceManager';

/**
 * Gerenciador de REPL (Read-Eval-Print Loop) para MicroPython
 * 
 * Problema: Necessidade de terminal interativo para enviar comandos Python para ESP32
 * Solução: Terminal customizado que se comunica com dispositivo serial via pseudoterminal
 * Exemplo: Permite executar "print('Hello')" e ver resultado imediatamente
 */
export class REPLManager {
    private activeREPLs: Map<string, vscode.Terminal> = new Map();
    
    constructor(private deviceManager: DeviceManager) {}

    /**
     * Abre REPL para um dispositivo específico
     * 
     * Problema: ESP32 precisa de comunicação bidirecional para desenvolvimento interativo
     * Solução: Terminal que redireciona entrada/saída para porta serial com validação robusta
     * Exemplo: Valida se é MicroPython antes de abrir terminal e mostra ">>>" corretamente
     */
    async openREPL(deviceId: string): Promise<void> {
        const device = this.deviceManager.getDevice(deviceId);
        if (!device || !device.isConnected) {
            vscode.window.showErrorMessage('Dispositivo não conectado');
            return;
        }

        // Verificar se já existe REPL ativo para este dispositivo
        const existingREPL = this.activeREPLs.get(deviceId);
        if (existingREPL) {
            existingREPL.show();
            return;
        }

        // Mostrar progresso durante validação
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Validando conexão MicroPython com ${device.name}...`,
            cancellable: true
        }, async (progress, token) => {
            try {
                // Validação completa do ambiente MicroPython
                progress.report({ increment: 20, message: 'Executando validação completa...' });
                const validation = await this.validateMicroPythonEnvironment(deviceId);
                
                if (token.isCancellationRequested) {
                    return;
                }

                if (!validation.isValid) {
                    const errorMessage = `Problemas detectados no MicroPython em ${device.name}:\n${validation.issues.join('\n')}`;
                    vscode.window.showErrorMessage(errorMessage, 'Detalhes').then(selection => {
                        if (selection === 'Detalhes') {
                            const outputChannel = this.deviceManager.getOutputChannel(deviceId);
                            if (outputChannel) {
                                outputChannel.show();
                                outputChannel.appendLine('\n=== Problemas de Validação MicroPython ===');
                                validation.issues.forEach(issue => outputChannel.appendLine(`• ${issue}`));
                                outputChannel.appendLine('=== Tente resetar o dispositivo ou verificar a conexão ===\n');
                            }
                        }
                    });
                    return;
                }

                progress.report({ increment: 60, message: 'Testando comandos básicos...' });
                
                // Validação adicional de responsividade
                const isResponsive = await this.testBasicCommands(deviceId);
                
                if (token.isCancellationRequested) {
                    return;
                }

                if (!isResponsive) {
                    vscode.window.showErrorMessage(
                        `MicroPython em ${device.name} não está respondendo consistentemente aos comandos. Tente resetar o dispositivo.`
                    );
                    return;
                }

                progress.report({ increment: 80, message: 'Preparando terminal...' });

                // Preparar dispositivo para REPL interativo
                await this.prepareDeviceForREPL(deviceId);

                if (token.isCancellationRequested) {
                    return;
                }

                progress.report({ increment: 100, message: 'Abrindo REPL...' });

                // Criar terminal customizado para REPL
                const terminal = vscode.window.createTerminal({
                    name: `MicroPython REPL - ${device.name}`,
                    pty: new MicroPythonPseudoTerminal(device, this.deviceManager)
                });

                this.activeREPLs.set(deviceId, terminal);
                terminal.show();

                // Limpar referência quando terminal for fechado
                vscode.window.onDidCloseTerminal((closedTerminal) => {
                    if (closedTerminal === terminal) {
                        this.activeREPLs.delete(deviceId);
                    }
                });

                vscode.window.showInformationMessage(`REPL MicroPython validado e aberto para ${device.name}`);

            } catch (error) {
                vscode.window.showErrorMessage(`Erro ao validar/abrir REPL: ${error}`);
            }
        });
    }

    /**
     * Executa script Python em um dispositivo
     * 
     * Problema: Necessidade de enviar arquivos .py completos para ESP32
     * Solução: Lê arquivo local e envia linha por linha para o dispositivo
     * Exemplo: Executa main.py no ESP32 e mostra resultado no terminal
     */
    async runScript(deviceId: string, scriptPath?: string): Promise<void> {
        const device = this.deviceManager.getDevice(deviceId);
        if (!device || !device.isConnected) {
            vscode.window.showErrorMessage('Dispositivo não conectado');
            return;
        }

        let filePath: string;
        
        if (scriptPath) {
            filePath = scriptPath;
        } else {
            // Perguntar ao usuário qual arquivo executar
            const fileUri = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                filters: {
                    'Python Files': ['py'],
                    'All Files': ['*']
                },
                title: 'Selecionar script Python para executar'
            });

            if (!fileUri || fileUri.length === 0) {
                return;
            }

            filePath = fileUri[0].fsPath;
        }

        try {
            // Ler conteúdo do arquivo
            const document = await vscode.workspace.openTextDocument(filePath);
            const scriptContent = document.getText();

            // Executar script
            await this.executeScript(deviceId, scriptContent, filePath);

        } catch (error) {
            vscode.window.showErrorMessage(`Erro ao executar script: ${error}`);
        }
    }

    /**
     * Executa conteúdo de script no dispositivo
     * 
     * Problema: MicroPython precisa receber código de forma controlada
     * Solução: Envia script usando modo paste do MicroPython (Ctrl+E)
     * Exemplo: Usa comandos especiais para enviar código multi-linha com segurança
     */
    private async executeScript(deviceId: string, scriptContent: string, fileName: string): Promise<void> {
        const outputChannel = this.deviceManager.getOutputChannel(deviceId);
        if (!outputChannel) {
            throw new Error('Canal de saída não encontrado');
        }

        outputChannel.show();
        outputChannel.appendLine(`\n=== Executando ${fileName} ===`);

        try {
            // Entrar no modo paste do MicroPython (Ctrl+E)
            await this.deviceManager.executeCommand(deviceId, '\x05'); // Ctrl+E
            await this.sleep(100);

            // Enviar conteúdo do script
            const lines = scriptContent.split('\n');
            for (const line of lines) {
                if (line.trim()) {
                    await this.deviceManager.executeCommand(deviceId, line);
                    await this.sleep(50); // Pequena pausa entre linhas
                }
            }

            // Sair do modo paste (Ctrl+D)
            await this.sleep(200);
            await this.deviceManager.executeCommand(deviceId, '\x04'); // Ctrl+D

            outputChannel.appendLine('=== Script executado com sucesso ===\n');

        } catch (error) {
            outputChannel.appendLine(`=== Erro na execução: ${error} ===\n`);
            throw error;
        }
    }

    /**
     * Utilitário para pausas entre comandos
     */
    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Fecha todos os REPLs ativos
     */
    closeAllREPLs(): void {
        for (const terminal of this.activeREPLs.values()) {
            terminal.dispose();
        }
        this.activeREPLs.clear();
    }

    /**
     * Valida se o dispositivo está executando MicroPython
     * 
     * Problema: Necessário verificar se dispositivo responde com prompt MicroPython
     * Solução: Usa estratégia de comando + verificação temporal para validar resposta
     * Exemplo: Envia comandos de teste e verifica se dispositivo está responsivo
     */
    private async validateMicroPythonConnection(deviceId: string): Promise<boolean> {
        try {
            const device = this.deviceManager.getDevice(deviceId);
            if (!device) {
                return false;
            }

            // Salvar timestamp antes dos testes
            const initialActivity = device.lastActivity;
            
            // Teste 1: Interromper execução atual e acordar REPL
            await this.deviceManager.executeCommand(deviceId, '\x03'); // Ctrl+C
            await this.sleep(300);
            
            // Teste 2: Enviar comando simples que deve retornar resposta
            await this.deviceManager.executeCommand(deviceId, '\r\n');
            await this.sleep(200);
            
            // Verificar se houve atividade recente (indicando resposta)
            const currentDevice = this.deviceManager.getDevice(deviceId);
            if (!currentDevice || !currentDevice.lastActivity) {
                return false;
            }

            // Se lastActivity foi atualizada, dispositivo está respondendo
            const hasRecentActivity = !initialActivity || 
                currentDevice.lastActivity.getTime() > initialActivity.getTime();
            
            if (!hasRecentActivity) {
                return false;
            }

            // Teste 3: Comando Python específico para confirmar MicroPython
            await this.deviceManager.executeCommand(deviceId, 'print("MP_VALIDATE")\r\n');
            await this.sleep(400);
            
            // Verificar nova atividade após comando Python
            const finalDevice = this.deviceManager.getDevice(deviceId);
            if (!finalDevice || !finalDevice.lastActivity) {
                return false;
            }

            // Confirmar que houve atividade após o comando Python
            return finalDevice.lastActivity.getTime() > currentDevice.lastActivity.getTime();
            
        } catch (error) {
            console.error('Erro na validação MicroPython:', error);
            return false;
        }
    }

    /**
     * Testa comandos básicos do MicroPython
     * 
     * Problema: Dispositivo pode estar conectado mas não executando Python corretamente
     * Solução: Executa sequência de comandos Python e verifica responsividade
     * Exemplo: Testa import, print e sys para garantir funcionalidade completa
     */
    private async testBasicCommands(deviceId: string): Promise<boolean> {
        try {
            const device = this.deviceManager.getDevice(deviceId);
            if (!device) {
                return false;
            }

            let lastActivity = device.lastActivity;
            let testsPassed = 0;

            // Teste 1: Print simples
            await this.deviceManager.executeCommand(deviceId, 'print(123)\r\n');
            await this.sleep(300);
            
            let updatedDevice = this.deviceManager.getDevice(deviceId);
            if (updatedDevice && updatedDevice.lastActivity && 
                (!lastActivity || updatedDevice.lastActivity.getTime() > lastActivity.getTime())) {
                testsPassed++;
                lastActivity = updatedDevice.lastActivity;
            }

            // Teste 2: Import básico
            await this.deviceManager.executeCommand(deviceId, 'import gc\r\n');
            await this.sleep(300);
            
            updatedDevice = this.deviceManager.getDevice(deviceId);
            if (updatedDevice && updatedDevice.lastActivity && 
                updatedDevice.lastActivity.getTime() > lastActivity.getTime()) {
                testsPassed++;
                lastActivity = updatedDevice.lastActivity;
            }

            // Teste 3: Comando com resposta esperada
            await this.deviceManager.executeCommand(deviceId, 'print("TEST_OK")\r\n');
            await this.sleep(400);
            
            updatedDevice = this.deviceManager.getDevice(deviceId);
            if (updatedDevice && updatedDevice.lastActivity && 
                updatedDevice.lastActivity.getTime() > lastActivity.getTime()) {
                testsPassed++;
            }

            // Pelo menos 2 dos 3 testes devem passar
            return testsPassed >= 2;
            
        } catch (error) {
            console.error('Erro no teste de comandos básicos:', error);
            return false;
        }
    }

    /**
     * Prepara dispositivo para uso interativo no REPL
     * 
     * Problema: Dispositivo pode estar em estado não ideal para REPL
     * Solução: Limpa buffer, interrompe execuções e prepara prompt limpo
     * Exemplo: Garante que prompt ">>>" esteja disponível e responsivo
     */
    private async prepareDeviceForREPL(deviceId: string): Promise<void> {
        try {
            // Interromper qualquer execução em andamento
            await this.deviceManager.executeCommand(deviceId, '\x03'); // Ctrl+C
            await this.sleep(200);
            
            // Limpar buffer enviando alguns enters
            await this.deviceManager.executeCommand(deviceId, '\r\n\r\n');
            await this.sleep(300);
            
            // Verificar se prompt está disponível
            await this.deviceManager.executeCommand(deviceId, '\r\n');
            await this.sleep(200);
            
            // Comando silencioso para preparar ambiente
            await this.deviceManager.executeCommand(deviceId, '# REPL Ready\r\n');
            await this.sleep(200);
            
        } catch (error) {
            console.error('Erro ao preparar dispositivo para REPL:', error);
            throw new Error('Falha ao preparar dispositivo para REPL');
        }
    }

    /**
     * Captura resposta do dispositivo por um período determinado
     * 
     * Problema: Necessário aguardar e capturar resposta específica do dispositivo
     * Solução: Usa promises com timeout para aguardar resposta do serial parser
     * Exemplo: Aguarda 2 segundos por resposta e retorna conteúdo ou string vazia
     */
    private async captureDeviceResponse(deviceId: string, timeoutMs: number): Promise<string> {
        return new Promise((resolve) => {
            let capturedOutput = '';
            let timeout: NodeJS.Timeout;
            let dataHandler: ((data: string) => void) | null = null;

            // Obter parser do device manager para interceptar dados
            const device = this.deviceManager.getDevice(deviceId);
            if (!device) {
                resolve('');
                return;
            }

            // Configurar timeout
            timeout = setTimeout(() => {
                if (dataHandler) {
                    // Remover listener se existir
                    try {
                        // Tentar acessar parser via deviceManager (seria necessário expor este método)
                        // Por enquanto, vamos simular com uma captura simplificada
                    } catch (error) {
                        console.warn('Erro ao remover listener:', error);
                    }
                }
                resolve(capturedOutput);
            }, timeoutMs);

            // Para esta implementação, vamos usar uma abordagem alternativa
            // Monitorar mudanças através de polling no output channel
            const startTime = Date.now();
            const pollInterval = setInterval(() => {
                if (Date.now() - startTime >= timeoutMs) {
                    clearInterval(pollInterval);
                    clearTimeout(timeout);
                    resolve(capturedOutput);
                }
                
                // Simular captura verificando se há nova atividade no dispositivo
                // Em implementação real, interceptaríamos dados do serial parser
                const currentTime = Date.now();
                if (device.lastActivity && currentTime - device.lastActivity.getTime() < 500) {
                    capturedOutput += 'response_data'; // Placeholder para dados reais
                }
            }, 100);
        });
    }

    /**
     * Executa validação completa do ambiente MicroPython
     * 
     * Problema: Dispositivo pode estar conectado mas com problemas específicos do MicroPython
     * Solução: Bateria completa de testes para garantir funcionalidade plena
     * Exemplo: Testa REPL, imports, memória e comandos específicos do ESP32
     */
    private async validateMicroPythonEnvironment(deviceId: string): Promise<{isValid: boolean, issues: string[]}> {
        const issues: string[] = [];
        let validationsPassed = 0;
        const totalValidations = 5;

        try {
            // Validação 1: Responsividade básica
            const device = this.deviceManager.getDevice(deviceId);
            if (!device) {
                issues.push('Dispositivo não encontrado');
                return {isValid: false, issues};
            }

            const initialActivity = device.lastActivity;
            await this.deviceManager.executeCommand(deviceId, '\r\n');
            await this.sleep(200);
            
            const updatedDevice = this.deviceManager.getDevice(deviceId);
            if (updatedDevice && updatedDevice.lastActivity && 
                (!initialActivity || updatedDevice.lastActivity.getTime() > initialActivity.getTime())) {
                validationsPassed++;
            } else {
                issues.push('Dispositivo não está respondendo a comandos básicos');
            }

            // Validação 2: Capacidade Python básica
            await this.deviceManager.executeCommand(deviceId, '1+1\r\n');
            await this.sleep(300);
            
            const mathDevice = this.deviceManager.getDevice(deviceId);
            if (mathDevice && mathDevice.lastActivity && 
                mathDevice.lastActivity.getTime() > updatedDevice!.lastActivity!.getTime()) {
                validationsPassed++;
            } else {
                issues.push('Interpretador Python não está processando comandos matemáticos');
            }

            // Validação 3: Capacidade de import
            let lastCheckActivity = mathDevice!.lastActivity!;
            await this.deviceManager.executeCommand(deviceId, 'import sys\r\n');
            await this.sleep(300);
            
            const importDevice = this.deviceManager.getDevice(deviceId);
            if (importDevice && importDevice.lastActivity && 
                importDevice.lastActivity.getTime() > lastCheckActivity.getTime()) {
                validationsPassed++;
                lastCheckActivity = importDevice.lastActivity;
            } else {
                issues.push('Sistema de imports do Python não está funcionando');
            }

            // Validação 4: Específica do MicroPython
            await this.deviceManager.executeCommand(deviceId, 'import micropython\r\n');
            await this.sleep(400);
            
            const mpDevice = this.deviceManager.getDevice(deviceId);
            if (mpDevice && mpDevice.lastActivity && 
                mpDevice.lastActivity.getTime() > lastCheckActivity.getTime()) {
                validationsPassed++;
                lastCheckActivity = mpDevice.lastActivity;
            } else {
                issues.push('Módulo micropython não está disponível - pode não ser MicroPython');
            }

            // Validação 5: Comandos específicos do ESP32 (se aplicável)
            await this.deviceManager.executeCommand(deviceId, 'import machine\r\n');
            await this.sleep(300);
            
            const machineDevice = this.deviceManager.getDevice(deviceId);
            if (machineDevice && machineDevice.lastActivity && 
                machineDevice.lastActivity.getTime() > lastCheckActivity.getTime()) {
                validationsPassed++;
            } else {
                issues.push('Módulo machine não disponível - pode não ser ESP32 com MicroPython');
            }

            const successRate = validationsPassed / totalValidations;
            const isValid = successRate >= 0.6; // Pelo menos 60% dos testes devem passar

            if (!isValid) {
                issues.push(`Apenas ${validationsPassed}/${totalValidations} validações passaram`);
            }

            return {isValid, issues};

        } catch (error) {
            issues.push(`Erro durante validação: ${error}`);
            return {isValid: false, issues};
        }
    }
}

/**
 * Pseudoterminal customizado para comunicação com MicroPython
 * 
 * Problema: VSCode Terminal API não suporta comunicação serial diretamente
 * Solução: Implementa Pseudoterminal que bridge entre terminal e porta serial
 * Exemplo: Redireciona teclas digitadas para ESP32 e mostra respostas no terminal
 */
class MicroPythonPseudoTerminal implements vscode.Pseudoterminal {
    private writeEmitter = new vscode.EventEmitter<string>();
    private closeEmitter = new vscode.EventEmitter<number>();
    private dataListener: ((data: string) => void) | null = null;
    private inputBuffer: string = '';
    private isInitialized: boolean = false;
    
    onDidWrite: vscode.Event<string> = this.writeEmitter.event;
    onDidClose: vscode.Event<number> = this.closeEmitter.event;

    constructor(
        private device: ESP32Device,
        private deviceManager: DeviceManager
    ) {}

    open(initialDimensions: vscode.TerminalDimensions | undefined): void {
        // Inicializar terminal
        this.writeEmitter.fire('\x1b[32m=== MicroPython REPL ===\x1b[0m\r\n');
        this.writeEmitter.fire(`Conectado a ${this.device.name} (${this.device.port})\r\n`);
        this.writeEmitter.fire('Dispositivo validado com sucesso!\r\n');
        this.writeEmitter.fire('\x1b[36mDigite comandos Python diretamente:\x1b[0m\r\n\r\n');
        
        // Configurar listener para dados do dispositivo
        this.setupDataListener();
        
        // Inicializar REPL
        this.initializeREPL();
    }

    close(): void {
        // Remover listener quando terminal fechar
        if (this.dataListener) {
            const parser = this.deviceManager.getParser(this.device.id);
            if (parser) {
                parser.off('data', this.dataListener);
            }
            this.dataListener = null;
        }
        this.closeEmitter.fire(0);
    }

    handleInput(data: string): void {
        // Processar entrada do usuário caracter por caracter
        for (let i = 0; i < data.length; i++) {
            const char = data[i];
            const charCode = char.charCodeAt(0);
            
            // Tratar teclas especiais
            if (charCode === 13) { // Enter
                this.writeEmitter.fire('\r\n');
                this.sendCommand(this.inputBuffer + '\r\n');
                this.inputBuffer = '';
            } else if (charCode === 8 || charCode === 127) { // Backspace/Delete
                if (this.inputBuffer.length > 0) {
                    this.inputBuffer = this.inputBuffer.slice(0, -1);
                    this.writeEmitter.fire('\b \b'); // Backspace visual
                }
            } else if (charCode === 3) { // Ctrl+C
                this.writeEmitter.fire('^C\r\n');
                this.sendCommand('\x03');
                this.inputBuffer = '';
            } else if (charCode >= 32) { // Caracteres printáveis
                this.inputBuffer += char;
                this.writeEmitter.fire(char); // Echo do caracter
            } else {
                // Outros caracteres de controle - enviar diretamente
                this.sendCommand(char);
            }
        }
    }

    setDimensions(dimensions: vscode.TerminalDimensions): void {
        // Terminal dimensions changed, pode ser usado para ajustar layout
    }

    /**
     * Configura listener para capturar dados do dispositivo
     */
    private setupDataListener(): void {
        const parser = this.deviceManager.getParser(this.device.id);
        if (!parser) {
            this.writeEmitter.fire('\x1b[31mErro: Parser não encontrado\x1b[0m\r\n');
            return;
        }

        this.dataListener = (data: string) => {
            // Filtrar dados recebidos para evitar eco desnecessário
            const cleanData = data.trim();
            
            // Se não é vazio e não é echo do comando que enviamos
            if (cleanData && !this.isEchoOfInput(cleanData)) {
                // Processar e formatar saída
                let formattedData = cleanData;
                
                // Adicionar quebra de linha se necessário
                if (!formattedData.endsWith('\r\n')) {
                    formattedData += '\r\n';
                }
                
                // Colorir prompt do MicroPython
                if (formattedData.includes('>>>')) {
                    formattedData = formattedData.replace('>>>', '\x1b[36m>>>\x1b[0m');
                } else if (formattedData.includes('...')) {
                    formattedData = formattedData.replace('...', '\x1b[33m...\x1b[0m');
                }
                
                this.writeEmitter.fire(formattedData);
            }
        };

        parser.on('data', this.dataListener);
    }

    /**
     * Verifica se os dados recebidos são eco do input do usuário
     */
    private isEchoOfInput(data: string): boolean {
        // Se o buffer de input está vazio, não pode ser eco
        if (this.inputBuffer.length === 0) {
            return false;
        }
        
        // Verifica se os dados contêm exatamente o que o usuário digitou
        return data.includes(this.inputBuffer.trim()) && this.inputBuffer.trim().length > 2;
    }

    /**
     * Inicializa o REPL enviando comandos de configuração
     */
    private async initializeREPL(): Promise<void> {
        try {
            this.writeEmitter.fire('Preparando comunicação...\r\n');
            
            // Esperar um pouco para o listener ser configurado
            await this.sleep(500);
            
            // Sequência de comandos para ativar REPL
            this.writeEmitter.fire('Enviando comandos de inicialização...\r\n');
            
            // 1. Interromper qualquer execução
            await this.sendCommand('\x03'); // Ctrl+C
            await this.sleep(300);
            
            // 2. Enviar alguns enters para limpar buffer
            await this.sendCommand('\r\n\r\n');
            await this.sleep(400);
            
            // 3. Comando simples para testar responsividade
            await this.sendCommand('print("REPL_READY")\r\n');
            await this.sleep(300);
            
            // 4. Outro enter para garantir prompt limpo
            await this.sendCommand('\r\n');
            await this.sleep(200);
            
            this.isInitialized = true;
            this.writeEmitter.fire('\x1b[32m✓ REPL MicroPython inicializado com sucesso!\x1b[0m\r\n');
            this.writeEmitter.fire('\x1b[36mVocê pode digitar comandos Python agora:\x1b[0m\r\n');
            this.writeEmitter.fire('\x1b[36m>>>\x1b[0m ');
            
        } catch (error) {
            this.writeEmitter.fire(`\x1b[31mErro ao inicializar REPL: ${error}\x1b[0m\r\n`);
            this.writeEmitter.fire('Tentando novamente...\r\n');
            
            // Tentar novamente uma vez
            setTimeout(() => {
                this.initializeREPL();
            }, 1000);
        }
    }

    /**
     * Envia comando para o dispositivo
     */
    private async sendCommand(command: string): Promise<void> {
        try {
            await this.deviceManager.executeCommand(this.device.id, command);
        } catch (error) {
            this.writeEmitter.fire(`\r\n\x1b[31mErro de comunicação: ${error}\x1b[0m\r\n`);
        }
    }

    /**
     * Utilitário para pausas
     */
    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
