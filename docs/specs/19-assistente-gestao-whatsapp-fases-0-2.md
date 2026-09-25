# Assistente de gestão pelo WhatsApp — fases 0 a 2

Estado: contrato das fases 0 a 2. As fases 3 a 5 foram aprovadas depois e têm
implementação e limites próprios em [20-assistente-gestao-whatsapp-fases-3-5.md](20-assistente-gestao-whatsapp-fases-3-5.md).

## Modelo de cliente

**CONFIRMADO pelo usuário:** cada empresa contratada é uma organização da instalação.
O WhatsApp comercial conectado nessa organização envia as mensagens ao gestor.
O cadastro guarda o nome e o número do gestor, associado a um usuário ativo com
papel `manager` ou `admin` na mesma organização. O operador da plataforma pode
auxiliar por acompanhamento completo; acompanhamento somente leitura apenas inspeciona.

**CONFIRMADO pelo código:** `management_bindings` vincula organização, sessão
comercial e usuário gestor; a FK composta impede sessão de outra empresa. A página
`/app/settings/management` configura esse vínculo, resumo e alertas. Por padrão
não existe vínculo e nada é enviado.

## Caminho de uma pergunta

1. O webhook resolve organização e sessão pelo token/segredo confiável do canal.
2. Antes de criar contato, conversa ou lead, o ingresso compara o remetente com
   o número cadastrado. A mensagem do gestor fica em `management_messages`.
   Eventos sem autenticação são isolados. Ecos do comercial também ficam fora do funil.
   Na instalação WAHA, o compose passa `WHATSAPP_HOOK_HMAC_KEY`. Uma prova local
   na imagem fixada `2026.7.2` CORE/NOWEB confirmou HMAC SHA-512 válido nos
   webhooks `state.change` e `session.status`. A exigência global continua
   configurável para instalações que usam WAHA externo ou configuração anterior;
   na audiência do gestor a assinatura é sempre obrigatória. Uma resposta
   do gestor sem assinatura não confirma o número e abre aviso na Central.
3. O gestor responde a um código de seis dígitos enviado pelo próprio comercial.
   O verificador é HMAC; o texto na fila durável é cifrado por AES-GCM até o
   envio e substituído após chamar o transporte. Os seis dígitos recebidos também
   são ocultados no histórico. O código começa a expirar após o envio
   e tem até cinco tentativas. A confirmação revalida o vínculo do usuário.
4. Consultas usam a identidade do gestor verificado e apenas cinco ferramentas
   existentes do MCP, todas de leitura. A execução passa pelo orçamento e
   registro canônico de chamadas do modelo. Pedidos de alteração recebem uma
   resposta orientando o uso da aplicação.
5. A resposta entra na fila durável com chave de deduplicação. O envio revalida
   usuário, empresa, número, sessão, inscrições e limites do canal. Resultado
   incerto não é reenviado automaticamente.

## Resumo e avisos

O resumo diário usa a data e o fuso da organização. Conta oportunidades criadas
no dia, negócios abertos, avisos abertos da Central e agendamentos confirmados
no dia. O Radar compartilha a própria varredura limitada e declara essa
cobertura; sua contagem não é um total irrestrito da base.

Os avisos implementados são `central_critical` e `radar_critical`, escolhidos
na configuração e limitados por empresa/dia. Um aviso da Central só sai se
continua crítico e aberto. `pausar avisos` enviado pelo gestor suspende resumo
e alertas; consultas continuam. A retomada exige ajuste administrativo na tela.
Não há recomposição de resumos de dias anteriores após parada do scheduler.

## Desfecho e operação

`management_outbox` guarda pendente, aceito, falhou, incerto ou cancelado,
além de recibos de entrega/leitura autenticados. Aceito significa aceito pelo
transporte. Uma falha abre aviso na Central e aparece no histórico da página.
Somente falhas anteriores ao transporte podem receber tentativa manual. Para
resultado incerto, a pessoa verifica o comercial antes de qualquer novo envio.
Respostas de consultas com mais de dois dias não são repetidas: o gestor envia
uma pergunta nova para receber dados atuais.
Em canais com janela de atendimento, o gestor precisa abrir uma janela válida
antes de receber texto livre; uma janela fechada aparece como falha operacional.

O cron `/api/v1/cron/management-assistant` roda pelo scheduler e exige segredo
interno. As três tabelas recebem RLS e concessões somente a administradores
da organização para a Data API; as consultas service role usam filtro explícito
de `organization_id`.

**CONFIRMADO pelo código — recuperação e diagnóstico:** o cron tenta a entrega
mesmo se a produção de consultas ou resumos falhar, e devolve erro com as etapas
que falharam. Cada consulta tem seu próprio tratamento de erro. Uma falha não
transforma a pergunta em ignorada: sem resposta persistida, o lease de cinco
minutos expira e ela volta a ser elegível. Se a preparação da resposta falhar,
o sistema tenta enfileirar uma mensagem de contingência com a mesma chave única.
Se a fila estiver indisponível, a pergunta continua recuperável. Uma resposta
normal persistida encerra avisos anteriores de processamento; a contingência
mantém o aviso, pois não respondeu à pergunta original.

A tela mostra as perguntas sem expor seu texto e distingue processamento,
nova tentativa, resposta aguardando envio e recibos do canal. Uma contingência
entregue mantém visível a falha na preparação. O histórico consulta as respostas
pelos IDs das perguntas, independentemente dos resumos e alertas mais recentes.
Logs registram etapa e códigos controlados, sem copiar a mensagem do gestor ou
o texto livre de exceções.

## Limites aprovados

O assistente não modifica leads, funil, agenda, casos humanos, agentes ou
mensagens a clientes nas fases 0 a 2. A operação precisa de sessão comercial
conectada e do modelo de IA configurado na instalação. Não existe número
compartilhado entre organizações para enviar notificações.
