# Reserva de salas

Sistema de reserva para uma rede de escritórios compartilhados, com 2 mil salas e 50 mil pessoas. O problema central: quando várias pessoas tentam o mesmo horário ao mesmo tempo, **só uma pode conseguir, e todas precisam saber o resultado**.

**[Leia a arquitetura e as justificativas →](docs/ARQUITETURA.md)**

## Como funciona

- **Nunca há duas reservas no mesmo horário.** Uma restrição de exclusão do PostgreSQL impede a sobreposição, mesmo que a aplicação tenha um bug.
- **A pessoa nunca fica em dúvida.** Sucesso só é informado depois do `COMMIT`. Se a resposta se perde, repetir com a mesma `Idempotency-Key` devolve a reserva original, sem duplicar.
- **Consultas são rápidas e podem atrasar alguns segundos.** Cache de 5 s na leitura, e a confirmação sempre valida no banco.
- **E-mail fora do ar não atrapalha.** O aviso entra em uma outbox na mesma transação da reserva, e um worker separado faz a entrega com novas tentativas.

## Resultado sob disputa

```text
200 pessoas disputando a sala 7
  201 confirmada:  1
  409 recusada:    199
  outros:          0
  tempo total:     833 ms
```

## Como rodar

Requer Node.js 22 ou superior. O PostgreSQL vem embutido via npm, sem Docker ou instalação.

```bash
npm install
npm run dev      # banco, API e worker em http://localhost:3000
```

A primeira execução cria 2 mil salas, 50 mil pessoas e cerca de 50 mil reservas.

Na tela, o painel **Laboratório** permite:

- disparar 50 tentativas simultâneas no horário selecionado;
- derrubar o provedor de e-mail, reservar normalmente e ver os avisos saírem quando ele volta.

## Testes

```bash
npm test                # 28 testes contra um PostgreSQL real
npm run race            # disputa por HTTP (com npm run dev em outro terminal)
postman collection run postman/room-reservation.postman_collection.json
```

Os testes cobrem disputa no mesmo horário, sobreposição parcial, repetição com a mesma chave em série e em paralelo, corrida entre cancelar e reservar, consulta defasada, indisponibilidade do e-mail e vários workers em paralelo.

## API

| Método | Rota | Descrição |
| --- | --- | --- |
| `GET` | `/api/rooms?q=` | Busca salas |
| `GET` | `/api/rooms/:id/availability?date=` | Agenda do dia, com até 5 s de atraso |
| `POST` | `/api/reservations` | Confirma. Exige `Idempotency-Key` e `X-User-Id` |
| `POST` | `/api/reservations/:id/cancel` | Cancela. Exige `X-User-Id` |
| `GET` | `/api/me/reservations` | Reservas da pessoa, sempre atualizadas |

## Rodando como em produção

```bash
docker compose up -d
npm run build
DATABASE_URL=postgres://reservas:reservas@localhost:5432/reservas npm start
DATABASE_URL=postgres://reservas:reservas@localhost:5432/reservas npm run worker
```

## Limitações

Projeto de portfólio. Antes de ir para produção, precisaria de:

- **Autenticação real.** Hoje a pessoa é identificada pelo cabeçalho `X-User-Id`, que qualquer cliente pode forjar.
- **Provedor de e-mail real.** Basta implementar a interface `EmailSender`. O envio hoje é simulado.

## Tecnologias

Node.js, TypeScript, Fastify, PostgreSQL, Vitest e HTML/CSS/JavaScript sem framework.
