# Homologação do Assistente de Gestão pelo WhatsApp

Este roteiro valida a jornada real numa instalação de **homologação**, com uma organização, um WhatsApp comercial e um número de gestor reservados para teste. O teste local em `tests/e2e/assistente-gestao-whatsapp.spec.ts` cobre cadastro, entrada persistida, cron e fila com comercial desligado; esta prova de envio e recebimento pelo canal ainda é necessária.

## Preparação

1. Publique na homologação uma imagem versionada que contenha as migrations 0237 e 0238, o `baseline.sql` correspondente, o aplicativo e o scheduler da mesma revisão.
2. Confirme que aplicativo, scheduler e WAHA estão saudáveis e que a sessão comercial da organização está conectada. Use apenas os comandos de diagnóstico do [runbook de deploy](deploy.md); mantenha os dois arquivos de Compose na instalação com Traefik.
3. Separe um número de gestor de teste, vinculado a um usuário ativo com papel `manager` ou `admin` na organização. Evite usar dados de clientes reais.
4. Anote o horário e o fuso da organização, a revisão implantada e o identificador da organização. Não registre código de confirmação, telefone completo, corpo das mensagens nem segredos no relatório de teste.

## Jornada obrigatória

| Passo | Ação | Resultado esperado |
|---|---|---|
| Cadastro | Na tela **Configurações › Assistente de gestão**, escolha o comercial, o usuário gestor e o número; salve. | O número aparece como não confirmado e as consultas permanecem desativadas. |
| Confirmação | Solicite o código na tela e responda pelo número cadastrado. | O comercial envia o código; a confirmação aparece na tela e a mensagem de boas-vindas chega ao gestor. O código não aparece em texto aberto no histórico. |
| Consulta | Envie `faça um resumo do dia na clínica`. | A pergunta aparece no histórico; o scheduler produz uma resposta; a resposta entra na fila e chega ao mesmo número. Os números devem declarar o período e a cobertura disponíveis, sem inventar métricas clínicas que o CRM não mede. |
| Duplicação | Reenvie o mesmo evento de webhook com o mesmo identificador externo no ambiente de teste. | Apenas uma pergunta e uma resposta são persistidas. |
| Interrupção | Pare temporariamente o scheduler depois de receber uma pergunta; reinicie-o. | A pergunta fica pendente e é retomada após o reinício, sem resposta duplicada. |
| Falha de entrega | Desconecte a sessão comercial de teste e faça uma nova consulta; depois reconecte. | A resposta permanece pendente, com motivo `commercial_offline`, e deve sair após a reconexão. Confira o histórico. Um envio de resultado incerto não é repetido automaticamente. |
| Permissão | Revogue o vínculo do usuário gestor ou desative a função e envie outra pergunta. | Nenhuma consulta é executada ou enviada e o número não vira lead comercial. |
| Isolamento | Repita com uma segunda organização de teste. | Consultas, histórico e avisos não exibem dados da primeira organização. |

## Comandos e relatórios das fases 4 e 5

Ative **Comandos pelo WhatsApp** apenas na organização de teste. Prepare um negócio, uma conversa, um contato e uma tarefa fictícios da mesma organização. Para cada comando, confira que a proposta aparece antes de qualquer alteração, que um código incorreto não altera o CRM e que o código correto aplica a operação uma única vez. Repita a confirmação para verificar que o histórico devolve o resultado já registrado.

| Pedido de teste | Conferência no CRM |
|---|---|
| Mover o negócio para outra etapa do mesmo funil | A etapa muda uma vez e a atividade fica auditada. |
| Criar tarefa com prazo futuro | Surge uma única tarefa atribuída ao gestor. |
| Reservar tipo e horário já combinados com cliente fictício | O compromisso aparece uma vez na agenda, vinculado ao contato. Se o tipo exigir confirmação posterior, aparece pendente; horário ocupado é recusado. |
| Solicitar agendamento para o contato | Surge tarefa de confirmação; nenhum compromisso aparece na agenda até a equipe confirmar pelo fluxo próprio. |
| Transferir conversa e devolvê-la à fila | O responsável muda e os eventos de atribuição aparecem. |
| Pausar a IA para humano e retomar | O estado da conversa muda e a continuidade do atendimento permanece registrada. |

Desative os comandos entre proposta e confirmação e verifique que o código deixa de executar. Revogue o papel do gestor e repita. Envie `resumo da semana` e compare os dois períodos de sete dias locais completos com as consultas agregadas do CRM. Ative o envio semanal e o aviso de tarefa vencida; confirme uma saída por chave de deduplicação, o teto diário e o cancelamento do aviso quando a tarefa for concluída antes da entrega. Registre quaisquer casos que o modelo não consiga interpretar, sem tratar uma proposta não criada como comando executado.

## Onde localizar uma resposta silenciosa

Consulte por `organization_id` e pelo identificador externo do evento, nunca por telefone ou conteúdo. A sequência esperada é `management_messages` (entrada) → `management_outbox` (resposta com `dedupe_key = reply:<id da entrada>`) → recibos de entrega. Se não há entrada, examine autenticação e roteamento do webhook. Se a entrada existe sem resposta, examine o cron e o aviso na Central. Se a resposta está pendente ou falhou, examine a sessão comercial e a janela de atendimento. `accepted` significa que o transporte aceitou o envio; somente `delivered_at` ou `read_at` comprovam entrega ou leitura.

Registre para cada cenário: aprovado/reprovado, horário, revisão, identificadores técnicos e captura da tela sem dados pessoais. Uma falha reprovada exige correção e nova execução do cenário antes de liberar a instalação de produção.
